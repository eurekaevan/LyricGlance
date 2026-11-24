import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {animationsEnabled} from './shell-ui-utils.js';
import {
    normalizePanelTimeline,
    panelPanState,
    panelTimelinesEqual,
    wordPanState,
} from './ui-utils.js';

const PANEL_TEXT_OPACITY = 150;
const PANEL_TEXT_FADE_MS = 140;
const PANEL_PAN_END_PADDING = 8;
const PANEL_PAN_CATCH_UP_MS = 200;
const PANEL_EDGE_FADE_WIDTH = 8;
const TITLE_LOOP_SPEED = 35;

export const TITLE_LOOP_GAP = 32;
export const MAX_LAYOUT_WAIT_RETRIES = 12;

export function measureLabelText(label) {
    // Preferred actor sizes can be fixed/minimum CSS widths. Measure a copy
    // of the shaped text without wrapping/ellipsizing instead, including ink
    // overhang. Pango pixels use the text's resource scale, not logical units.
    label.ensure_style();
    const layout = label.clutter_text.get_layout().copy();
    layout.set_width(-1);
    layout.set_ellipsize(Pango.EllipsizeMode.NONE);
    const [ink, logical] = layout.get_pixel_extents();
    const left = Math.min(ink.x, logical.x);
    const right = Math.max(ink.x + ink.width, logical.x + logical.width);
    const scale = label.clutter_text.get_resource_scale();
    const node = label.get_theme_node();
    return (right - left) / scale + node.get_horizontal_padding() +
        node.get_border_width(St.Side.LEFT) + node.get_border_width(St.Side.RIGHT);
}

export function createTitleCopy(label, viewport) {
    const copy = new St.Label({
        style_class: label.get_style_class_name(),
        y_align: label.y_align,
        y_expand: label.y_expand,
        visible: false,
        accessible_role: Atk.Role.REDUNDANT_OBJECT,
    });
    copy.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
    copy.clutter_text.set_single_line_mode(true);
    for (const property of ['text', 'style', 'translation-x'])
        label.bind_property(property, copy, property, GObject.BindingFlags.SYNC_CREATE);
    viewport.layout_manager.setRepeatLabel(copy);
    viewport.add_child(copy);
    return copy;
}

export function loopTitle(label, period, delayMs, onComplete) {
    label.ease({
        translation_x: -period,
        delay: delayMs,
        duration: Math.max(1, Math.round(
            (period + label.translation_x) / TITLE_LOOP_SPEED * 1000)),
        mode: Clutter.AnimationMode.LINEAR,
        onComplete: () => {
            // The second copy is now exactly where the first started. Both
            // move together, so this reset preserves the visible pixels.
            label.translation_x = 0;
            onComplete();
        },
    });
}

class PanelEdgeFade extends (Shell.GLSLEffect ?? Clutter.ShaderEffect) {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init({enabled: false});
        this._edgesLocation = Shell.GLSLEffect ? this.get_uniform_location('edges') : 'edges';
        this._edges = [];
    }

    // Register only the native hook available on the selected parent.
    [Shell.GLSLEffect ? 'vfunc_build_pipeline' : 'vfunc_get_static_snippet']() {
        const declarations = 'uniform vec3 edges;';
        const code = `
            float x = cogl_tex_coord_in[0].x;
            float left = mix(1.0, clamp(x / edges.x, 0.0, 1.0), edges.y);
            float right = mix(1.0, clamp((1.0 - x) / edges.x, 0.0, 1.0), edges.z);
            cogl_color_out *= left * right;
        `;
        if (Shell.GLSLEffect)
            return this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, false);
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, code);
    }

    setEdges(width, offset, textWidth) {
        const edges = [
            Math.min(0.5, PANEL_EDGE_FADE_WIDTH / Math.max(1, width)),
            Math.min(1, Math.max(0, -offset / PANEL_EDGE_FADE_WIDTH)),
            Math.min(1, Math.max(0,
                (textWidth + offset - width) / PANEL_EDGE_FADE_WIDTH)),
        ];
        if (edges.every((value, index) => value === this._edges[index]))
            return;
        this._edges = edges;
        this.set_uniform_float(this._edgesLocation, 3, edges);
    }
}

export class PanelLabelLayout extends Clutter.LayoutManager {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init();
        this._panLabel = null;
        this._panWidth = 0;
        this._repeatLabel = null;
        this._repeatOffset = 0;
    }

    setRepeatLabel(label) {
        this._repeatLabel = label;
    }

    setRepeatOffset(offset) {
        if (this._repeatOffset === offset)
            return false;
        this._repeatOffset = offset;
        this.layout_changed();
        return true;
    }

    setPanLabel(label) {
        this._panLabel = label;
    }

    setPanWidth(width) {
        const nextWidth = Math.max(0, Number(width) || 0);
        if (this._panWidth === nextWidth)
            return false;
        this._panWidth = nextWidth;
        this.layout_changed();
        return true;
    }

    vfunc_get_preferred_width(container, forHeight) {
        let naturalWidth = 0;
        for (const child of container) {
            if (child === this._repeatLabel)
                continue;
            const [, childNaturalWidth] =
                child.get_preferred_width(forHeight);
            naturalWidth = Math.max(naturalWidth, childNaturalWidth);
        }
        return [0, naturalWidth];
    }

    vfunc_get_preferred_height(container, forWidth) {
        let minimumHeight = 0;
        let naturalHeight = 0;
        for (const child of container) {
            const childWidth = child === this._panLabel && this._panWidth > 0
                ? this._panWidth
                : forWidth;
            const [childMinimumHeight, childNaturalHeight] =
                child.get_preferred_height(childWidth);
            minimumHeight = Math.max(minimumHeight, childMinimumHeight);
            naturalHeight = Math.max(naturalHeight, childNaturalHeight);
        }
        return [minimumHeight, naturalHeight];
    }

    vfunc_allocate(container, box) {
        const viewportWidth = Math.max(0, box.get_width());
        const viewportHeight = Math.max(0, box.get_height());
        for (const child of container) {
            if (!child.visible)
                continue;
            let childWidth = viewportWidth;
            const fullText = child.clutter_text.get_ellipsize() === Pango.EllipsizeMode.NONE;
            if ((child === this._panLabel || child === this._repeatLabel) &&
                fullText && this._panWidth > 0)
                childWidth = Math.max(viewportWidth, this._panWidth);
            else if (fullText)
                childWidth = Math.max(viewportWidth, measureLabelText(child));
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(child === this._repeatLabel ? this._repeatOffset : 0, 0);
            childBox.set_size(childWidth, viewportHeight);
            child.allocate(childBox);
            // Native text layout may place RTL text at a nonzero origin, and
            // italic ink may extend left of zero. Anchor the complete bounds
            // inside the content box instead of clipping an overhanging glyph.
            if (fullText) {
                const [ink, logical] = child.clutter_text.get_layout().get_pixel_extents();
                const offset = -Math.min(ink.x, logical.x) /
                    child.clutter_text.get_resource_scale();
                const textBox = child.clutter_text.get_allocation_box();
                const localBox = new Clutter.ActorBox();
                localBox.set_size(childWidth, viewportHeight);
                const content = child.get_theme_node().get_content_box(localBox);
                // allocate() can reuse the previous text allocation. Derive
                // the origin from the content box so offsets never accumulate.
                if (Math.abs(textBox.x1 - (content.x1 + offset)) > 0.01) {
                    textBox.x1 = content.x1 + offset;
                    textBox.x2 = content.x2 + offset;
                    child.clutter_text.allocate(textBox);
                }
            }
        }
    }
}

export class PanelLabelView {
    constructor({
        animationsEnabled: animationPreference = animationsEnabled,
        isMenuOpen = () => false,
    } = {}) {
        this._animationsEnabled = animationPreference;
        this._isMenuOpen = isMenuOpen;
        this._laters = global.compositor.get_laters();
        this._panLaterId = 0;
        this._geometryLaterId = 0;
        this._naturalWidth = 0;
        this._fontKey = '';
        this._wordTimeoutId = 0;
        this._wordSyncEnabled = true;
        this._words = null;
        this._wordGeometry = null;
        this._scrollable = false;
        this._looping = false;
        this._timeline = null;
        this._timelineAnchorUs = 0;
        this._textKey = null;
        this._targetX = 0;
        this._paused = false;
        this._playing = false;
        this._hovered = false;
        this._retries = 0;
        this._viewportWidth = 0;

        this._label = new St.Label({
            style_class: 'lyric-glance-panel-label',
            text: '',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this._label.clutter_text.set_single_line_mode(true);
        this._panLabel = new St.Label({
            style_class: 'lyric-glance-panel-label',
            text: '',
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            visible: false,
        });
        this._panLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this._panLabel.clutter_text.set_single_line_mode(true);

        const layout = new PanelLabelLayout();
        layout.setPanLabel(this._panLabel);
        this.actor = new St.Widget({
            style_class: 'lyric-glance-panel-label-viewport',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            clip_to_allocation: true,
            layout_manager: layout,
        });
        this.actor.add_child(this._label);
        this.actor.add_child(this._panLabel);
        this._titleCopy = createTitleCopy(this._panLabel, this.actor);
        this._fadeEffect = new PanelEdgeFade();
        this.actor.add_effect(this._fadeEffect);

        this._panLabel.connectObject('notify::translation-x', () =>
            this._updateFade(), this.actor);
        this.actor.connectObject('notify::allocation', () => {
            const width = this.actor.get_allocation_box().get_width();
            if (width === this._viewportWidth)
                return;
            this._viewportWidth = width;
            this._queueRestart();
        }, this);
        this._panLabel.connectObject('style-changed', () =>
            this._queueGeometryCheck(), this.actor);
        this._panLabel.clutter_text.connectObject('resource-scale-changed', () =>
            this._queueGeometryCheck(), this.actor);
        this._panLabel.connectObject('notify::style', () =>
            this._queueGeometryCheck(), this.actor);
        this._label.connectObject('style-changed', () =>
            this._queueGeometryCheck(), this.actor);
        this._panLabel.connectObject('notify::allocation', () =>
            this._queueGeometryCheck(), this.actor);
        this.actor.connectObject('notify::mapped', () => {
            if (this.actor.mapped)
                this.schedule();
            else
                this.cancel();
        }, this);
    }

    get text() {
        return this._label?.text ?? '';
    }

    setText(text, {
        scrollable = false,
        timeline = null,
        contentKey = null,
        words = null,
        loop = false,
    } = {}) {
        if (!this.actor)
            return;
        const looping = Boolean(loop);
        const canScroll = Boolean(scrollable || looping);
        const normalizedTimeline = looping ? null : normalizePanelTimeline(timeline);
        const timelineChanged = !panelTimelinesEqual(
            this._timeline, normalizedTimeline);
        const wordsChanged = this._words !== words;
        this._words = words;
        if (wordsChanged)
            this._wordGeometry = null;
        this._timeline = normalizedTimeline;
        this._timelineAnchorUs = GLib.get_monotonic_time();
        this._label.clutter_text.set_ellipsize(
            canScroll && (normalizedTimeline || (looping && this._animationsEnabled()))
                ? Pango.EllipsizeMode.NONE
                : Pango.EllipsizeMode.END);
        if (this._label.text === text &&
            this._scrollable === canScroll &&
            this._looping === looping &&
            this._textKey === contentKey) {
            if (timelineChanged || wordsChanged)
                this.schedule();
            return;
        }

        this.cancel();
        this._scrollable = canScroll;
        this._looping = looping;
        this._textKey = contentKey;
        this._label.remove_all_transitions();
        this._label.text = text;
        this._panLabel.text = text;
        this._naturalWidth = 0;
        this._updateFade();
        if (!this._label.mapped || !this._animationsEnabled()) {
            this._label.opacity = 255;
            this.schedule();
            return;
        }

        this._label.opacity = PANEL_TEXT_OPACITY;
        this._label.ease({
            opacity: 255,
            duration: PANEL_TEXT_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.schedule();
    }

    prepareWidthChange() {
        if (!this.actor)
            return;
        // Stop an active translation before width/style invalidation. A
        // running transition can otherwise request a stage-view update while
        // the panel hierarchy is waiting for its new allocation.
        this.cancel({preserveDisplay:
            this._paused && Boolean(this._panLabel?.visible)});
    }

    setMaxWidth(width) {
        if (!this.actor)
            return;
        this.actor.set_style(`max-width: ${width}px;`);
        // A preference or icon change can leave the allocated width unchanged
        // under external constraints. Restart after layout even when no width
        // notification arrives, since the active pan was cancelled above.
        this._queueRestart();
    }

    setPlaying(playing) {
        if (!this.actor || this._playing === playing)
            return;
        const nowUs = GLib.get_monotonic_time();
        if (this._timeline) {
            this._timeline = {
                ...this._timeline,
                positionMs: this._positionAt(nowUs),
            };
            this._timelineAnchorUs = nowUs;
        }
        this._playing = playing;
        if (this._looping) {
            if (playing)
                this.resume();
            else
                this.pause();
            return;
        }
        this.schedule();
    }

    setWordSyncEnabled(enabled) {
        if (!this.actor)
            return;
        this._wordSyncEnabled = Boolean(enabled);
        this.schedule();
    }

    setHovered(hovered) {
        if (!this.actor)
            return;
        this._hovered = Boolean(hovered);
        if (this._hovered) {
            if (!this._isMenuOpen())
                this.pause();
        } else {
            this.resume();
        }
    }

    onMenuOpenChanged(open) {
        if (!this.actor)
            return;
        if (open)
            this.resume();
        else if (this._hovered)
            this.pause();
    }

    clear() {
        if (!this.actor)
            return;
        this._words = null;
        this._wordGeometry = null;
        this._scrollable = false;
        this._looping = false;
        this._timeline = null;
        this._timelineAnchorUs = 0;
        this._textKey = null;
        this.cancel();
        this.setPlaying(false);
    }

    schedule() {
        if (!this.actor)
            return;
        this._retries = 0;
        this.cancel({preserveDisplay:
            Boolean(this._panLabel?.visible) && this._scrollable &&
            Boolean(this._timeline || this._looping)});
        this._label?.clutter_text.set_ellipsize(
            this._scrollable && (this._timeline ||
                (this._looping && this._animationsEnabled()))
                ? Pango.EllipsizeMode.NONE
                : Pango.EllipsizeMode.END);
        this._updateFade();
        this._queuePan();
    }

    cancel({preserveDisplay = false} = {}) {
        if (!preserveDisplay)
            this._retries = 0;
        if (this._geometryLaterId && this._laters) {
            this._laters.remove(this._geometryLaterId);
            this._geometryLaterId = 0;
        }
        if (this._wordTimeoutId) {
            GLib.source_remove(this._wordTimeoutId);
            this._wordTimeoutId = 0;
        }
        if (this._panLaterId && this._laters) {
            this._laters.remove(this._panLaterId);
            this._panLaterId = 0;
        }
        this._panLabel?.remove_all_transitions();
        if (this._panLabel && !preserveDisplay) {
            this._panLabel.translation_x = 0;
            this._panLabel.hide();
            this._titleCopy?.hide();
            this.actor?.layout_manager?.setPanWidth(0);
            this.actor?.layout_manager?.setRepeatOffset(0);
        }
        if (!preserveDisplay) {
            this._label?.show();
            this._paused = false;
        }
        this._targetX = 0;
    }

    pause() {
        if (!this.actor)
            return;
        const hoverPaused = this._hovered && !this._isMenuOpen();
        if (hoverPaused && this._panLabel?.visible)
            this._paused = true;
        const hadWordTimer = Boolean(this._wordTimeoutId);
        if (hadWordTimer) {
            GLib.source_remove(this._wordTimeoutId);
            this._wordTimeoutId = 0;
            this._paused = true;
        }
        const transition =
            this._panLabel?.get_transition('translation-x');
        if (!transition)
            return;
        const currentX = this._panLabel.translation_x;
        this._panLabel.remove_transition('translation-x');
        this._panLabel.translation_x = currentX;
        this._paused =
            hoverPaused || this._looping || hadWordTimer ||
            Math.abs(currentX - this._targetX) > 0.5;
    }

    resume() {
        if (!this.actor || !this._paused || !this._playing ||
            !this._panLabel?.visible)
            return;
        // A queued layout restart owns the held position until allocation
        // settles; it will resume here using the latest geometry and clock.
        if (this._panLaterId)
            return;
        this._paused = false;
        if (!this._animationsEnabled()) {
            this.schedule();
            return;
        }
        if (this._looping) {
            this._continueTitlePan();
            return;
        }
        // Catch the timeline where it will be when the transition finishes,
        // rather than chasing a position already in the past.
        const panState = this._panState(
            this._positionAt(GLib.get_monotonic_time() +
                PANEL_PAN_CATCH_UP_MS * 1000));
        if (!panState)
            return;
        this._panLabel.ease({
            translation_x: panState.initialX,
            duration: PANEL_PAN_CATCH_UP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._startPan(),
        });
    }

    _updateFade() {
        if (!this._fadeEffect || !this._animationsEnabled)
            return;
        const width = this._viewportWidth;
        const textWidth = this._naturalWidth;
        const active = this._scrollable &&
            (this._timeline || this._looping) &&
            this._animationsEnabled() && width > 0 && textWidth > width + 1;
        this._fadeEffect.enabled = Boolean(active);
        if (active) {
            const offset = this._panLabel.visible
                ? this._panLabel.translation_x : 0;
            this._fadeEffect.setEdges(width,
                offset,
                // The repeating copy keeps overflowing on the right, while
                // the left fade follows the actual displacement from the start.
                this._looping ? width - offset + PANEL_EDGE_FADE_WIDTH : textWidth);
        }
    }

    _queuePan(laterType = Meta.LaterType.IDLE) {
        if (this._panLaterId) {
            this._laters.remove(this._panLaterId);
            this._panLaterId = 0;
        }
        if (!this._scrollable ||
            (!this._timeline && !this._looping) ||
            !this.actor?.mapped)
            return;

        this._panLaterId = this._laters.add(
            laterType,
            () => {
                this._panLaterId = 0;
                this._startPan();
                return GLib.SOURCE_REMOVE;
            });
    }

    _queueRestart() {
        if (!this._scrollable ||
            (!this._timeline && !this._looping) ||
            !this.actor?.mapped)
            return;
        // Style/font and allocation changes must restart outside allocation.
        if (this._panLaterId)
            this._laters.remove(this._panLaterId);
        this._panLaterId = this._laters.add(Meta.LaterType.IDLE, () => {
            this._panLaterId = 0;
            this._wordGeometry = null;
            this.schedule();
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueGeometryCheck() {
        if (this._geometryLaterId || !this._scrollable ||
            (!this._timeline && !this._looping) ||
            !this.actor?.mapped)
            return;
        this._geometryLaterId = this._laters.add(Meta.LaterType.IDLE, () => {
            this._geometryLaterId = 0;
            if (!this._scrollable ||
                (!this._timeline && !this._looping) ||
                !this.actor?.mapped)
                return GLib.SOURCE_REMOVE;
            this._panLabel.ensure_style();
            const width = measureLabelText(this._panLabel);
            const fontKey = this._panLabel.get_theme_node().get_font().to_string() +
                '/' + this._panLabel.clutter_text.get_resource_scale();
            const origin = this._panLabel.clutter_text.get_allocation_box().x1 +
                this._panLabel.clutter_text.translation_x;
            if (width !== this._naturalWidth ||
                fontKey !== this._fontKey ||
                (this._wordGeometry && this._wordGeometry.origin !== origin)) {
                this._wordGeometry = null;
                this.schedule();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _startPan() {
        if (this._wordTimeoutId) {
            GLib.source_remove(this._wordTimeoutId);
            this._wordTimeoutId = 0;
        }
        if (!this._scrollable ||
            (!this._timeline && !this._looping) ||
            !this.actor?.mapped)
            return;
        if (this._looping && !this._animationsEnabled()) {
            this.cancel();
            return;
        }

        const naturalWidth = measureLabelText(this._panLabel);
        this._naturalWidth = naturalWidth;
        this._fontKey = this._panLabel.get_theme_node().get_font().to_string() +
            '/' + this._panLabel.clutter_text.get_resource_scale();
        // Actor.width may report a preferred width while layout is invalid.
        // Only allocation notifications provide the actual text viewport.
        const viewportWidth = this._viewportWidth;
        const overflow = Math.ceil(naturalWidth - viewportWidth);
        if (!(viewportWidth > 0) || overflow <= 0) {
            this.cancel();
            this._updateFade();
            return;
        }

        // Changing the custom layout invalidates the actor hierarchy. Let
        // Clutter process that change before updating visibility, and wait
        // again for visible labels before starting a transition below.
        const panWidthChanged = this.actor.layout_manager.setPanWidth(naturalWidth);
        const repeatChanged = this._looping &&
            this.actor.layout_manager.setRepeatOffset(naturalWidth + TITLE_LOOP_GAP);
        if (panWidthChanged || repeatChanged) {
            if (++this._retries <= MAX_LAYOUT_WAIT_RETRIES) {
                this._queuePan(Meta.LaterType.BEFORE_REDRAW);
                return;
            }
            this.cancel();
            this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            this._updateFade();
            return;
        }
        // Hidden labels are skipped by the layout manager. Show them first,
        // then wait for valid full-width allocations before any transition.
        this._panLabel.show();
        this._titleCopy.visible = this._looping;
        this._label.hide();
        if (!this.actor.has_allocation() ||
            !this._panLabel.has_allocation() ||
            this._panLabel.get_allocation_box().get_width() < naturalWidth - 0.5 ||
            (this._looping && (!this._titleCopy.has_allocation() ||
                this._titleCopy.get_allocation_box().get_width() < naturalWidth - 0.5))) {
            if (++this._retries <= MAX_LAYOUT_WAIT_RETRIES) {
                this._queuePan(Meta.LaterType.BEFORE_REDRAW);
                return;
            }
            this.cancel();
            this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            this._updateFade();
            return;
        }
        this._retries = 0;
        const preservePosition = this._paused && this._panLabel.visible;
        if (this._looping) {
            this._panLabel.remove_all_transitions();
            this._panLabel.translation_x = preservePosition
                ? Math.clamp(this._panLabel.translation_x,
                    -(naturalWidth + TITLE_LOOP_GAP), 0) : 0;
            this._updateFade();
            this._targetX = -(naturalWidth + TITLE_LOOP_GAP);
            this._continueTitlePan(preservePosition ? 0 : 1000);
            return;
        }
        const panState = this._panState(this._positionAt());
        if (!panState)
            return;
        this._panLabel.remove_all_transitions();
        // A refreshed timeline or layout must not move hovered text. Clamp
        // only to the full new range, not the current word/page's target.
        const minimumX = -(overflow <= PANEL_PAN_END_PADDING
            ? overflow : overflow + PANEL_PAN_END_PADDING);
        this._panLabel.translation_x = preservePosition
            ? Math.clamp(this._panLabel.translation_x, minimumX, 0)
            : panState.initialX;
        this._updateFade();
        this._targetX = panState.targetX;
        const hoverPaused = this._hovered && !this._isMenuOpen();
        if (hoverPaused || preservePosition) {
            this._paused = true;
            if (!hoverPaused)
                this.resume();
            return;
        }
        const shouldAnimate = this._playing && panState.shouldAnimate;
        if (shouldAnimate) {
            this._panLabel.ease({
                translation_x: this._targetX,
                delay: Math.min(2_147_483_647, panState.delayMs),
                duration: Math.min(2_147_483_647, panState.durationMs),
                mode: Clutter.AnimationMode.LINEAR,
            });
        }
        if (this._playing && panState.nextMs) {
            this._wordTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Math.min(2_147_483_647, Math.max(1, Math.ceil(
                    (panState.nextMs - this._positionAt()) /
                    this._timeline.playbackRate))), () => {
                    this._wordTimeoutId = 0;
                    this._startPan();
                    return GLib.SOURCE_REMOVE;
                });
            GLib.Source.set_name_by_id(
                this._wordTimeoutId, '[LyricGlance] panel word pan');
        }
    }

    _isTextRtl() {
        return !this._looping &&
            Pango.find_base_dir(this._label?.text ?? '', -1) ===
                Pango.Direction.RTL;
    }

    _orientPanState(panState, distance) {
        if (!panState || !this._isTextRtl())
            return panState;
        return {
            ...panState,
            initialX: -distance - panState.initialX,
            targetX: -distance - panState.targetX,
        };
    }

    _panState(positionMs) {
        const naturalWidth = this._naturalWidth;
        const width = this._viewportWidth;
        const overflow = Math.ceil(naturalWidth - width);
        const distance = overflow <= PANEL_PAN_END_PADDING
            ? overflow : overflow + PANEL_PAN_END_PADDING;
        if (!this._animationsEnabled()) {
            return this._orientPanState(
                panelPanState(this._timeline, positionMs,
                    distance, Math.max(1, width * 0.8)),
                distance);
        }
        if (overflow > PANEL_PAN_END_PADDING &&
            this._wordSyncEnabled && this._words?.length) {
            const layout = this._panLabel.clutter_text.get_layout();
            const serial = layout.get_serial();
            const resourceScale = this._panLabel.clutter_text.get_resource_scale();
            const textOrigin = this._panLabel.clutter_text.get_allocation_box().x1 +
                this._panLabel.clutter_text.translation_x;
            if (this._wordGeometry?.serial !== serial ||
                this._wordGeometry.endMs !== this._timeline.endMs ||
                this._wordGeometry.scale !== resourceScale ||
                this._wordGeometry.origin !== textOrigin) {
                let byteIndex = 0;
                let previousEndMs = this._timeline.startMs;
                let previousEndX = 0;
                const measured = [];
                const encoder = new TextEncoder();
                const words = this._words;
                let valid = words.map(word => word.text).join('') === this._label.text;
                // Bidirectional runs and split graphemes cannot be followed
                // reliably with a monotonically moving horizontal focus.
                let characterByte = 0;
                let characterX = -Infinity;
                for (const character of this._label.text) {
                    const rectangle = layout.index_to_pos(characterByte);
                    if (rectangle.width < 0 || rectangle.x < characterX)
                        valid = false;
                    characterX = rectangle.x;
                    const codePoint = character.codePointAt(0);
                    characterByte += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 :
                        codePoint <= 0xffff ? 3 : 4;
                }
                for (let index = 0; valid && index < words.length; index++) {
                    const word = words[index];
                    const start = layout.index_to_pos(byteIndex);
                    byteIndex += encoder.encode(word.text).length;
                    const end = layout.index_to_pos(byteIndex);
                    const startX = start.x / Pango.SCALE / resourceScale + textOrigin;
                    const endX = end.x / Pango.SCALE / resourceScale + textOrigin;
                    const endMs = word.endMs ?? words[index + 1]?.startMs ??
                        this._timeline.endMs;
                    valid = Number.isFinite(word.startMs) && Number.isFinite(endMs) &&
                        word.startMs >= previousEndMs && endMs > word.startMs &&
                        endMs <= this._timeline.endMs && start.width >= 0 &&
                        startX >= previousEndX && endX > startX;
                    measured.push({startMs: word.startMs, endMs, startX, endX});
                    previousEndMs = endMs;
                    previousEndX = endX;
                }
                this._wordGeometry = {
                    serial,
                    scale: resourceScale,
                    origin: textOrigin,
                    endMs: this._timeline.endMs,
                    words: valid ? measured : null,
                };
            }
            const state = wordPanState(this._timeline, positionMs,
                this._wordGeometry.words, width, distance);
            if (state)
                return state;
        }
        return this._orientPanState(
            panelPanState(this._timeline, positionMs, distance),
            distance);
    }

    _continueTitlePan(delayMs = 0) {
        if (!this._looping || !this._panLabel?.visible ||
            !this.actor?.mapped || !this._animationsEnabled())
            return;
        if (!this._playing || (this._hovered && !this._isMenuOpen())) {
            this._paused = true;
            return;
        }
        this._paused = false;
        loopTitle(this._panLabel, -this._targetX, delayMs,
            () => this._continueTitlePan());
    }

    _positionAt(nowUs = GLib.get_monotonic_time()) {
        const timeline = this._timeline;
        if (!timeline)
            return 0;
        const elapsedMs = this._playing &&
            this._timelineAnchorUs > 0
            ? Math.max(0, nowUs - this._timelineAnchorUs) / 1000 *
                timeline.playbackRate
            : 0;
        return Math.min(timeline.endMs, timeline.positionMs + elapsedMs);
    }

    destroy() {
        this._panLabel?.clutter_text?.disconnectObject(this.actor);
        this._panLabel?.disconnectObject(this.actor);
        this._label?.disconnectObject(this.actor);
        this.actor?.disconnectObject(this);
        this._scrollable = false;
        this._looping = false;
        this._hovered = false;
        this._playing = false;
        this._viewportWidth = 0;
        this._naturalWidth = 0;
        this._fontKey = '';
        this._textKey = null;
        this._timelineAnchorUs = 0;
        this._timeline = null;
        this._words = null;
        this._wordGeometry = null;
        this.cancel();
        this._label?.remove_all_transitions();
        this._panLabel?.remove_all_transitions();
        this.actor?.layout_manager?.setPanLabel(null);
        this.actor?.layout_manager?.setRepeatLabel(null);
        this._titleCopy?.destroy();
        this._panLabel?.destroy();
        this._label?.destroy();
        this.actor?.destroy();
        this.actor = null;
        this._label = null;
        this._panLabel = null;
        this._titleCopy = null;
        this._fadeEffect = null;
        this._laters = null;
        this._animationsEnabled = null;
        this._isMenuOpen = null;
    }
}
