import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtworkView} from './artwork-view.js';
import {
    comfortableScrollTarget,
    formatDuration,
    getLineVisualLevel,
    normalizePanelTimeline,
    panelPanState,
    panelTimelinesEqual,
    wordPanState,
} from './ui-utils.js';

const OFFSET_STEP_MS = 500;
const MIN_OFFSET_MS = -10_000;
const MAX_OFFSET_MS = 10_000;
const PANEL_PREFERRED_WIDTH = 320;
const PANEL_TEXT_OPACITY = 150;
const PANEL_TEXT_FADE_MS = 140;
const PANEL_PAN_END_PADDING = 8;
const PANEL_PAN_CATCH_UP_MS = 200;
const PANEL_EDGE_FADE_WIDTH = 8;
const LYRIC_TRANSITION_MS = 160;
const SCROLL_TRANSITION_MS = 220;
const LINE_VISUAL_CLASS_NAMES = [
    'lyric-glance-line-static',
    'lyric-glance-line-far',
    'lyric-glance-line-mid',
    'lyric-glance-line-near',
    'lyric-glance-line-current',
];

function animationsEnabled() {
    return St.Settings.get().enable_animations;
}

function configureEllipsized(label) {
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    label.clutter_text.set_single_line_mode(true);
}

function createMetadataLabel(styleClass, {multiline = false} = {}) {
    const label = new St.Label({
        style_class: styleClass,
        text: '',
        x_expand: true,
        y_align: Clutter.ActorAlign.START,
    });
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    label.clutter_text.set_single_line_mode(!multiline);
    if (multiline) {
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
    }
    return label;
}

function musicIcon() {
    return Gio.ThemedIcon.new_from_names([
        'music-note-symbolic',
        'audio-x-generic-symbolic',
        'media-playback-start-symbolic',
    ]);
}

function setButtonEnabled(button, enabled) {
    button.reactive = enabled;
    button.can_focus = enabled;
    if (enabled)
        button.remove_style_pseudo_class('insensitive');
    else
        button.add_style_pseudo_class('insensitive');
}

class PanelEdgeFade extends Shell.GLSLEffect {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init({enabled: false});
        this._edgesLocation = this.get_uniform_location('edges');
        this._edges = [];
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            'uniform vec3 edges;', `
                float x = cogl_tex_coord_in[0].x;
                float left = mix(1.0, clamp(x / edges.x, 0.0, 1.0), edges.y);
                float right = mix(1.0, clamp((1.0 - x) / edges.x, 0.0, 1.0), edges.z);
                cogl_color_out *= left * right;
            `, false);
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

class PanelLabelLayout extends Clutter.LayoutManager {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init();
        this._panLabel = null;
        this._panWidth = 0;
    }

    setPanLabel(label) {
        this._panLabel = label;
    }

    setPanWidth(width) {
        const nextWidth = Math.max(0, Number(width) || 0);
        if (Math.abs(this._panWidth - nextWidth) < 0.5)
            return false;
        this._panWidth = nextWidth;
        this.layout_changed();
        return true;
    }

    vfunc_get_preferred_width(container, forHeight) {
        let naturalWidth = 0;
        for (const child of container) {
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
            let childWidth = viewportWidth;
            if (child === this._panLabel && this._panWidth > 0)
                childWidth = Math.max(viewportWidth, this._panWidth);
            else if (child.clutter_text.get_ellipsize() === Pango.EllipsizeMode.NONE)
                childWidth = Math.max(viewportWidth, child.get_preferred_width(-1)[1]);
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(0, 0);
            childBox.set_size(childWidth, viewportHeight);
            child.allocate(childBox);
        }
    }
}

class PlaybackProgressView {
    constructor({onSeek} = {}) {
        this._onSeek = onSeek;
        this._target = null;
        this._dragTarget = null;
        this._dragging = false;
        this._updating = false;
        this._durationUs = 0;
        this.actor = new St.BoxLayout({
            style_class: 'lyric-glance-progress',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._slider = new Slider(0);
        this._slider.accessible_name = _('Playback position');
        this.actor.add_child(this._slider);
        const timeRow = new St.BoxLayout({
            style_class: 'lyric-glance-progress-time',
            x_expand: true,
        });
        this._currentLabel = new St.Label({text: '0:00', x_expand: true});
        this._durationLabel = new St.Label({text: '0:00'});
        timeRow.add_child(this._currentLabel);
        timeRow.add_child(this._durationLabel);
        this.actor.add_child(timeRow);
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
            this._dragTarget = this._slider.reactive ? this._target : null;
        });
        this._slider.connect('drag-end', () => {
            const target = this._dragTarget;
            this._dragging = false;
            this._dragTarget = null;
            if (target && this._slider.reactive)
                this._onSeek?.(target, this._slider.value * this._durationUs);
        });
        this._slider.connect('notify::value', () => {
            if (this._updating || !this._slider.reactive)
                return;
            this._currentLabel.text = formatDuration(
                this._slider.value * this._durationUs / 1_000_000);
            if (!this._dragging)
                this._onSeek?.(this._target, this._slider.value * this._durationUs);
        });
        this.actor.hide();
    }

    setControlState(target, enabled) {
        if (JSON.stringify(target) !== JSON.stringify(this._target) || !enabled)
            this.cancelDrag();
        this._target = target;
        setButtonEnabled(this._slider, Boolean(enabled));
    }

    cancelDrag() {
        // Leave the gesture active until its release, but never commit it.
        this._dragTarget = null;
    }

    setProgress(positionUs, durationUs) {
        const duration = Number(durationUs);
        this._durationUs = Number.isFinite(duration) && duration > 0 ? duration : 0;
        this.actor.visible = this._durationUs > 0;
        if (this._dragging && this._dragTarget)
            return;
        const position = Math.min(Math.max(0, Number(positionUs) || 0),
            this._durationUs);
        this._updating = true;
        // Shell 50 retains a separate step origin after user interaction.
        this._slider._unsnappedValue = null;
        this._slider.value = this._durationUs > 0 ? position / this._durationUs : 0;
        this._updating = false;
        this._currentLabel.text = formatDuration(position / 1_000_000);
        this._durationLabel.text = formatDuration(this._durationUs / 1_000_000);
    }

    destroy() {
        this.cancelDrag();
        this._onSeek = null;
        this._target = null;
        this.actor = null;
        this._slider = null;
        this._currentLabel = null;
        this._durationLabel = null;
    }
}

export class LyricsIndicator {
    constructor(accessibleName, {
        onOffsetAdjust,
        onOffsetReset,
        onPlayerSelected,
        onPopupOpenChanged,
        onTranslationAction,
        onMediaControl,
        animationsEnabled: animationPreference = animationsEnabled,
    } = {}) {
        this._onOffsetAdjust = onOffsetAdjust ?? null;
        this._onOffsetReset = onOffsetReset ?? null;
        this._onPlayerSelected = onPlayerSelected ?? null;
        this._onPopupOpenChanged = onPopupOpenChanged ?? null;
        this._onTranslationAction = onTranslationAction ?? null;
        this._onMediaControl = onMediaControl ?? null;
        this._mediaTarget = null;
        this._mediaRequest = 0;
        this._mediaBusy = false;
        this._mediaState = null;
        this._animationsEnabled = animationPreference;
        this._lyricRows = [];
        this._lyricLabels = [];
        this._translationLabels = [];
        this._document = null;
        this._translationDocument = null;
        this._translationEnabled = false;
        this._translationDisplayMode = 'bilingual';
        this._translationStatus = 'idle';
        this._wordSyncEnabled = true;
        this._wordStateSignature = '';
        this._activeLyricIndex = -1;
        this._scrollLaterId = 0;
        this._scrollRequest = null;
        this._layoutAnchorSignalId = 0;
        this._layoutAnchorAdjustment = null;
        this._panelPanLaterId = 0;
        this._panelGeometryLaterId = 0;
        this._panelNaturalWidth = 0;
        this._panelFontKey = '';
        this._panelWordTimeoutId = 0;
        this._panelWords = null;
        this._panelWordGeometry = null;
        this._panelPanScrollable = false;
        this._panelPanLooping = false;
        this._panelPanTimeline = null;
        this._panelPanTimelineAnchorUs = 0;
        this._panelTextKey = null;
        this._panelPanTargetX = 0;
        this._panelPanPaused = false;
        this._panelPlaying = false;
        this._panelHovered = false;
        this._titlePanLaterId = 0;
        this._titleViewportWidth = 0;
        this._panelViewportWidth = 0;
        this._maxPanelWidth = 500;
        this._showIcon = true;
        this._laters = global.compositor.get_laters();

        this.actor = new PanelMenu.Button(0.5, accessibleName);
        this.actor.add_style_class_name('lyric-glance-indicator');
        this._panelBox = new St.BoxLayout({
            style_class: 'lyric-glance-panel',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this._icon = new St.Icon({
            style_class: 'lyric-glance-panel-icon',
            gicon: musicIcon(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            style_class: 'lyric-glance-panel-label',
            text: '',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        configureEllipsized(this._label);
        this._panelPanLabel = new St.Label({
            style_class: 'lyric-glance-panel-label',
            text: '',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            visible: false,
        });
        this._panelPanLabel.clutter_text.set_ellipsize(
            Pango.EllipsizeMode.NONE);
        this._panelPanLabel.clutter_text.set_single_line_mode(true);
        this._panelLabelLayout = new PanelLabelLayout();
        this._panelLabelLayout.setPanLabel(this._panelPanLabel);
        this._labelViewport = new St.Widget({
            style_class: 'lyric-glance-panel-label-viewport',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            clip_to_allocation: true,
            layout_manager: this._panelLabelLayout,
        });
        this._labelViewport.add_child(this._label);
        this._labelViewport.add_child(this._panelPanLabel);
        this._panelFadeEffect = new PanelEdgeFade();
        this._labelViewport.add_effect(this._panelFadeEffect);
        this._panelPanLabel.connect('notify::translation-x', () =>
            this._updatePanelFade());
        this._labelViewport.connect('notify::allocation', () => {
            const width = this._labelViewport.get_allocation_box().get_width();
            if (width === this._panelViewportWidth)
                return;
            this._panelViewportWidth = width;
            this._queuePanelPanRestart();
        });
        this._panelPanLabel.connect('style-changed', () =>
            this._queuePanelGeometryCheck());
        this._panelPanLabel.connect('notify::style', () =>
            this._queuePanelGeometryCheck());
        this._label.connect('style-changed', () =>
            this._queuePanelGeometryCheck());
        this._panelPanLabel.connect('notify::allocation', () =>
            this._queuePanelGeometryCheck());
        this._labelViewport.connect('notify::mapped', () => {
            if (this._labelViewport.mapped)
                this._schedulePanelPan();
            else
                this._cancelPanelPan();
        });
        this.actor.connect('enter-event', () => {
            this._panelHovered = true;
            if (!this.actor.menu.isOpen)
                this._pausePanelPan();
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('leave-event', () => {
            this._panelHovered = false;
            this._resumePanelPan();
            return Clutter.EVENT_PROPAGATE;
        });
        this._panelBox.add_child(this._icon);
        this._panelBox.add_child(this._labelViewport);
        this.actor.add_child(this._panelBox);

        this._buildMenu();
        this.actor.hide();
    }

    _buildMenu() {
        this.actor.menu.box.add_style_class_name('lyric-glance-menu');

        const mediaItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'lyric-glance-media-section',
            reactive: false,
            can_focus: false,
        });
        const mediaBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const mediaHeader = new St.BoxLayout({
            style_class: 'lyric-glance-media-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._artworkView = new ArtworkView({
            animationsEnabled: this._animationsEnabled,
        });
        mediaHeader.add_child(this._artworkView.actor);
        const metadataBox = new St.BoxLayout({
            style_class: 'lyric-glance-metadata',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel = createMetadataLabel('lyric-glance-title');
        this._titleViewport = new St.Widget({
            x_expand: true, clip_to_allocation: true,
            layout_manager: new PanelLabelLayout(),
        });
        this._titleViewport.add_child(this._titleLabel);
        this._titleLabel.connect('style-changed', () => this._queueTitlePan());
        let titleAllocatedWidth = 0;
        this._titleLabel.connect('notify::allocation', () => {
            const width = Math.round(this._titleLabel.width);
            if (width === titleAllocatedWidth)
                return;
            titleAllocatedWidth = width;
            this._queueTitlePan();
        });
        this._titleViewport.connect('notify::mapped', () => {
            if (this._titleViewport.mapped)
                this._queueTitlePan();
            else
                this._cancelTitlePan();
        });
        this._titleAnimationSettings = St.Settings.get();
        this._titleAnimationSignalId = this._titleAnimationSettings.connect(
            'notify::enable-animations', () => {
                this._cancelTitlePan();
                this._queueTitlePan();
                this._schedulePanelPan();
            });
        this._titleViewport.connect('notify::allocation', () => {
            const width = this._titleViewport.get_allocation_box().get_width();
            if (width === this._titleViewportWidth)
                return;
            this._titleViewportWidth = width;
            this._queueTitlePan();
        });
        this._artistLabel = createMetadataLabel('lyric-glance-artist');
        this._albumLabel = createMetadataLabel('lyric-glance-album');
        metadataBox.add_child(this._titleViewport);
        metadataBox.add_child(this._artistLabel);
        metadataBox.add_child(this._albumLabel);
        mediaHeader.add_child(metadataBox);
        mediaBox.add_child(mediaHeader);
        const mediaControls = new St.BoxLayout({
            style_class: 'lyric-glance-media-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaButtons = new Map();
        for (const [action, label, icon] of [
            ['Previous', _('Previous track'), 'media-skip-backward-symbolic'],
            ['Play', _('Play'), 'media-playback-start-symbolic'],
            ['Next', _('Next track'), 'media-skip-forward-symbolic'],
        ]) {
            const button = new St.Button({
                style_class: 'button lyric-glance-media-button',
                accessible_name: label,
                child: new St.Icon({icon_name: icon, icon_size: 18}),
                can_focus: true,
            });
            button.connect('clicked', () => {
                const command = action === 'Play' &&
                    this._mediaState?.playbackStatus === 'Playing' ? 'Pause' : action;
                this._requestMediaControl(command, this._mediaTarget);
            });
            this._mediaButtons.set(action, button);
            mediaControls.add_child(button);
        }
        mediaBox.add_child(mediaControls);
        this._progressView = new PlaybackProgressView({
            onSeek: (target, positionUs) =>
                this._requestMediaControl('SetPosition', target, positionUs),
        });
        mediaBox.add_child(this._progressView.actor);
        this._mediaErrorLabel = new St.Label({
            style_class: 'lyric-glance-media-error',
            text: _('Could not control playback'),
            visible: false,
        });
        this._mediaErrorLabel.clutter_text.set_line_wrap(true);
        mediaBox.add_child(this._mediaErrorLabel);
        this.setMediaState(null);
        mediaItem.add_child(mediaBox);
        this.actor.menu.addMenuItem(mediaItem);

        const lyricsItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'lyric-glance-scroll-item',
            reactive: false,
            can_focus: false,
        });
        this._lyricsBox = new St.BoxLayout({
            style_class: 'lyric-glance-lines',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scrollView = new St.ScrollView({
            style_class: 'lyric-glance-scroll',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._lyricsBox,
        });
        lyricsItem.add_child(this._scrollView);
        this.actor.menu.addMenuItem(lyricsItem);

        this._lyricsSourceItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'lyric-glance-source-item',
            reactive: false,
            can_focus: false,
        });
        this._lyricsSourceLabel = new St.Label({
            style_class: 'lyric-glance-source-label',
            text: '',
        });
        this._lyricsSourceItem.add_child(this._lyricsSourceLabel);
        this._lyricsSourceItem.hide();
        this.actor.menu.addMenuItem(this._lyricsSourceItem);

        this._translationItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'lyric-glance-translation-status',
            reactive: false,
            can_focus: false,
        });
        const translationControls = new St.BoxLayout({
            x_expand: true,
        });
        this._translationStatusLabel = new St.Label({
            text: _('Translation available on request'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._translationActionButton = new St.Button({
            style_class: 'button flat lyric-glance-translation-button',
            label: _('Translate'),
            can_focus: true,
        });
        translationControls.add_child(this._translationStatusLabel);
        translationControls.add_child(this._translationActionButton);
        this._translationItem.add_child(translationControls);
        this.actor.menu.addMenuItem(this._translationItem);

        const offsetItem = new PopupMenu.PopupBaseMenuItem({
            style_class: 'lyric-glance-offset',
            reactive: false,
            can_focus: false,
        });
        const offsetBox = new St.BoxLayout({
            style_class: 'lyric-glance-footer',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const titleRow = new St.BoxLayout({
            style_class: 'lyric-glance-offset-heading',
            x_expand: true,
        });
        const offsetTitle = new St.Label({
            style_class: 'lyric-glance-offset-title',
            text: _('Lyrics timing'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleRow.add_child(offsetTitle);
        this._resetButton = new St.Button({
            style_class: 'button flat lyric-glance-reset-button',
            label: _('Reset'),
            can_focus: true,
            accessible_name: _('Reset lyrics offset'),
        });
        titleRow.add_child(this._resetButton);
        offsetBox.add_child(titleRow);

        const controls = new St.BoxLayout({
            style_class: 'lyric-glance-offset-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._decreaseButton = new St.Button({
            style_class: 'button flat lyric-glance-offset-button',
            label: '−0.5 s',
            can_focus: true,
            accessible_name: _('Decrease lyrics offset by 0.5 seconds'),
        });
        this._offsetLabel = new St.Label({
            style_class: 'lyric-glance-offset-label',
            text: '+0.0 s',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._increaseButton = new St.Button({
            style_class: 'button flat lyric-glance-offset-button',
            label: '+0.5 s',
            can_focus: true,
            accessible_name: _('Increase lyrics offset by 0.5 seconds'),
        });
        controls.add_child(this._decreaseButton);
        controls.add_child(this._offsetLabel);
        controls.add_child(this._increaseButton);
        offsetBox.add_child(controls);
        this._effectiveOffsetLabel = new St.Label({
            style_class: 'lyric-glance-effective-offset',
            text: _('Global +0.0 s  ·  Effective +0.0 s'),
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        offsetBox.add_child(this._effectiveOffsetLabel);
        offsetItem.add_child(offsetBox);
        this.actor.menu.addMenuItem(offsetItem);

        this.actor.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._playerMenu = new PopupMenu.PopupSubMenuMenuItem(_('Player'), false);
        this._playerMenu.add_style_class_name('lyric-glance-player');
        this._playerMenu.label.add_style_class_name(
            'lyric-glance-player-label');
        configureEllipsized(this._playerMenu.label);
        this.actor.menu.addMenuItem(this._playerMenu);

        this._decreaseButton.connect('clicked', () => {
            this._onOffsetAdjust?.(-OFFSET_STEP_MS);
        });
        this._increaseButton.connect('clicked', () => {
            this._onOffsetAdjust?.(OFFSET_STEP_MS);
        });
        this._resetButton.connect('clicked', () => {
            this._onOffsetReset?.();
        });
        this._translationActionButton.connect('clicked', () => {
            this._onTranslationAction?.({
                forceRefresh: this._translationStatus === 'available',
            });
        });
        this.actor.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._scheduleScrollToActive({force: true, immediate: true});
                this._resumePanelPan();
                this._queueTitlePan();
            } else {
                this._cancelScheduledScroll();
                this._cancelTitlePan();
                if (this._panelHovered)
                    this._pausePanelPan();
            }
            this._onPopupOpenChanged?.(open);
        });

        this.setOffsets(0, 0);
        this.setPlayers([], 'auto');
        this.setTranslationEnabled(false);
        this._showLyricsMessage(_('No lyrics found'));
    }

    setText(text, {
        scrollable = false,
        timeline = null,
        contentKey = null,
        words = null,
        loop = false,
    } = {}) {
        this._icon.visible = this._showIcon || !text;
        const iconOnly = !text;
        if (this._labelViewport.visible === iconOnly) {
            this._labelViewport.visible = !iconOnly;
            this._applyPanelWidth();
        }
        const looping = Boolean(loop);
        const canScroll = Boolean(scrollable || looping);
        const normalizedTimeline = looping ? null : normalizePanelTimeline(timeline);
        const timelineChanged = !panelTimelinesEqual(
            this._panelPanTimeline, normalizedTimeline);
        const wordsChanged = this._panelWords !== words;
        this._panelWords = words;
        if (wordsChanged)
            this._panelWordGeometry = null;
        this._panelPanTimeline = normalizedTimeline;
        this._panelPanTimelineAnchorUs = GLib.get_monotonic_time();
        this._label.clutter_text.set_ellipsize(
            canScroll && (normalizedTimeline || (looping && this._animationsEnabled()))
                ? Pango.EllipsizeMode.NONE
                : Pango.EllipsizeMode.END);
        if (!this._label ||
            (this._label.text === text &&
                this._panelPanScrollable === canScroll &&
                this._panelPanLooping === looping &&
                this._panelTextKey === contentKey)) {
            if (this._label && (timelineChanged || wordsChanged))
                this._schedulePanelPan();
            return;
        }

        this._cancelPanelPan();
        this._panelPanScrollable = canScroll;
        this._panelPanLooping = looping;
        this._panelTextKey = contentKey;
        this._label.remove_all_transitions();
        this._label.text = text;
        this._panelPanLabel.text = text;
        this._updatePanelFade();
        if (!this._label.mapped || !this._animationsEnabled()) {
            this._label.opacity = 255;
            this._schedulePanelPan();
            return;
        }

        this._label.opacity = PANEL_TEXT_OPACITY;
        this._label.ease({
            opacity: 255,
            duration: PANEL_TEXT_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._schedulePanelPan();
    }

    setTrack(metadata, trackKey) {
        this.updateTrackMetadata(metadata, trackKey);
        this.setProgress(0, metadata.durationUs);
        this._document = null;
        this._translationDocument = null;
        this.setTranslationState('idle');
        this._showLyricsMessage(_('Loading lyrics…'));
    }

    updateTrackMetadata(metadata, trackKey) {
        this.updateMetadataDisplay(metadata);
        this.setArtwork(metadata.artUrl, trackKey);
    }

    updateMetadataDisplay(metadata) {
        const title = metadata.title ?? '';
        if (title !== this._titleLabel.text) {
            this._cancelTitlePan();
            this._titleLabel.text = title;
            this._queueTitlePan();
        }
        this._artistLabel.text = metadata.artist ?? '';
        const album = metadata.album ?? '';
        this._albumLabel.text = album;
        this._artistLabel.show();
        this._albumLabel.visible = Boolean(album);
    }

    setArtwork(artUrl, trackKey) {
        this._artworkView.setArtwork(artUrl, trackKey);
    }

    setMediaState(state) {
        const target = state?.controlTarget ?? null;
        if (JSON.stringify(target) !== JSON.stringify(this._mediaTarget)) {
            this._mediaRequest++;
            this._mediaBusy = false;
            this._mediaErrorLabel.hide();
        }
        this._mediaTarget = target;
        this._mediaState = state;
        const capabilities = state?.capabilities ?? {};
        const enabled = Boolean(target && capabilities.CanControl && !this._mediaBusy);
        const playing = state?.playbackStatus === 'Playing';
        const playButton = this._mediaButtons.get('Play');
        playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        playButton.accessible_name = playing ? _('Pause') : _('Play');
        setButtonEnabled(playButton, enabled &&
            Boolean(playing ? capabilities.CanPause : capabilities.CanPlay));
        setButtonEnabled(this._mediaButtons.get('Previous'),
            enabled && Boolean(capabilities.CanGoPrevious));
        setButtonEnabled(this._mediaButtons.get('Next'),
            enabled && Boolean(capabilities.CanGoNext));
        const trackId = state?.metadata.trackId ?? '';
        this._progressView.setControlState(target, enabled && capabilities.CanSeek &&
            state.metadata.durationUs > 0 && GLib.Variant.is_object_path(trackId) &&
            trackId !== '/org/mpris/MediaPlayer2/TrackList/NoTrack');
    }

    async _requestMediaControl(action, target, positionUs = null) {
        if (!target || !this._onMediaControl || this._mediaBusy)
            return;
        const request = ++this._mediaRequest;
        this._mediaBusy = true;
        this._mediaErrorLabel.hide();
        this.setMediaState(this._mediaState);
        try {
            await this._onMediaControl(action, target, positionUs);
        } catch (error) {
            if (this.actor && request === this._mediaRequest) {
                this._mediaErrorLabel.show();
                console.warn(`LyricGlance: playback control failed: ${error.message}`);
            }
        } finally {
            if (this.actor && request === this._mediaRequest) {
                this._mediaBusy = false;
                this.setMediaState(this._mediaState);
            }
        }
    }

    cancelMediaDrag() {
        this._progressView.cancelDrag();
    }

    setProgress(positionUs, durationUs, options = {}) {
        this._progressView?.setProgress(positionUs, durationUs);
        this._setPanelPlaying(Boolean(options.playing));
    }

    clearTrack() {
        this._cancelTitlePan();
        this._panelWords = null;
        this._panelWordGeometry = null;
        this._panelPanScrollable = false;
        this._panelPanLooping = false;
        this._panelPanTimeline = null;
        this._panelPanTimelineAnchorUs = 0;
        this._panelTextKey = null;
        this._cancelPanelPan();
        this._setPanelPlaying(false);
        this._titleLabel.text = '';
        this._artistLabel.text = '';
        this._albumLabel.text = '';
        this._artworkView.clear();
        this.setProgress(0, 0);
        this._document = null;
        this._translationDocument = null;
        this._lyricsSourceLabel.text = '';
        this._lyricsSourceItem.hide();
        this._clearLyricsRows();
        this._updateTranslationControlVisibility();
    }

    setLyrics(document, status = 'complete') {
        this._document = document ?? null;
        this._translationDocument = null;
        const source = typeof document?.source === 'string' ? document.source : '';
        const provider = source === 'lrclib' || source.startsWith('lrclib-')
            ? 'LRCLIB'
            : source === 'lrcapi' || source.startsWith('lrcapi-')
                ? 'LrcAPI'
                : null;
        const showSource = Boolean(provider &&
            (document?.instrumental || document?.lines?.length));
        this._lyricsSourceLabel.text = showSource ? _('Lyrics source: %s').format(provider) : '';
        this._lyricsSourceItem.visible = showSource;
        if (document?.instrumental) {
            this._showLyricsMessage(_('Instrumental'));
            return;
        }
        if (!document?.lines?.length) {
            this._showLyricsMessage(status === 'retrying'
                ? _('Retrying lyrics…')
                : status === 'unavailable'
                    ? _('Lyrics service temporarily unavailable')
                    : _('No lyrics found'));
            return;
        }

        this._clearLyricsRows();
        for (const line of document.lines) {
            const row = new PopupMenu.PopupBaseMenuItem({
                style_class: 'lyric-glance-line',
                reactive: false,
                can_focus: false,
            });
            const lineBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            const label = new St.Label({
                style_class: 'lyric-glance-original',
                text: line.text,
                x_expand: true,
            });
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            label.clutter_text.set_line_wrap(true);
            label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            const translatedLabel = new St.Label({
                style_class: 'lyric-glance-translation',
                text: '',
                x_expand: true,
                visible: false,
            });
            translatedLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            translatedLabel.clutter_text.set_line_wrap(true);
            translatedLabel.clutter_text.set_line_wrap_mode(
                Pango.WrapMode.WORD_CHAR);
            lineBox.add_child(label);
            lineBox.add_child(translatedLabel);
            row.add_child(lineBox);
            this._lyricsBox.add_child(row);
            this._lyricRows.push(row);
            this._lyricLabels.push(label);
            this._translationLabels.push(translatedLabel);
        }
        this._applyLineVisualLevels(-1, -1, false);
        this._applyTranslationToRows();
        this._updateTranslationControlVisibility();
    }

    setTranslation(translation) {
        this._translationDocument = translation ?? null;
        this._applyTranslationToRows();
    }

    setTranslationEnabled(enabled) {
        this._translationEnabled = Boolean(enabled);
        this._updateTranslationControlVisibility();
        this._applyTranslationToRows();
    }

    setTranslationDisplayMode(mode) {
        this._translationDisplayMode = [
            'bilingual', 'original', 'translated',
        ].includes(mode) ? mode : 'bilingual';
        this._applyTranslationToRows();
    }

    setTranslationState(status, {fromCache = false} = {}) {
        this._translationStatus = status;
        const states = {
            idle: [_('Translation available on request'), _('Translate'), true],
            loading: [_('Loading translation…'), _('Loading…'), false],
            available: [
                fromCache
                    ? _('Translation loaded from cache')
                    : _('Translation available'),
                _('Refresh'),
                true,
            ],
            not_configured: [_('Translation API key is not configured'), '', false],
            provider_unavailable: [_('Translation provider unavailable'), _('Retry'), true],
            network_error: [_('Translation network error'), _('Retry'), true],
            provider_error: [_('Translation provider error'), _('Retry'), true],
            authentication_error: [_('Translation API key was rejected'), _('Retry'), true],
            rate_limited: [_('Translation rate limited'), _('Retry'), true],
            invalid_response: [_('Translation response was invalid'), _('Retry'), true],
            canceled: [_('Translation canceled'), _('Retry'), true],
            same_language: [_('Original language matches target language'), '', false],
            skipped: ['', '', false],
        };
        const [text, action, enabled] = states[status] ?? states.provider_error;
        this._translationStatusLabel.text = text;
        this._translationActionButton.label = action;
        this._translationActionButton.accessible_name = action
            ? _('Lyrics translation action: %s').format(action)
            : _('Lyrics translation');
        this._translationActionButton.visible = Boolean(action);
        setButtonEnabled(this._translationActionButton, enabled);
        this._updateTranslationControlVisibility();
    }

    translatedTextForLine(lineId) {
        return this._translationDocument?.lines
            ?.find(line => line.lineId === lineId)?.text ?? null;
    }

    isOriginalLineVisible(index) {
        return Boolean(this._lyricLabels[index]?.visible);
    }

    setCurrentLyricIndex(index, {reposition = false} = {}) {
        const nextIndex = this._lyricRows[index] ? index : -1;
        if (nextIndex === this._activeLyricIndex)
            return;

        const previousIndex = this._activeLyricIndex;
        if (previousIndex >= 0)
            this._resetLineText(previousIndex);

        this._activeLyricIndex = nextIndex;
        this._wordStateSignature = '';
        const current = this._lyricRows[nextIndex];
        this._applyLineVisualLevels(
            previousIndex,
            nextIndex,
            Boolean(current) && this.actor.menu.isOpen && !reposition &&
                this._animationsEnabled());

        if (current && this.actor.menu.isOpen)
            this._scheduleScrollToActive({
                force: reposition,
                immediate: reposition,
            });
    }

    setWordSyncEnabled(enabled) {
        this._wordSyncEnabled = Boolean(enabled);
        this._wordStateSignature = '';
        if (!this._wordSyncEnabled && this._activeLyricIndex >= 0)
            this._resetLineText(this._activeLyricIndex);
        this._schedulePanelPan();
    }

    setCurrentWordStates(index, states) {
        if (!this._wordSyncEnabled || index !== this._activeLyricIndex ||
            this._document?.syncLevel !== 'word')
            return;

        const line = this._document.lines[index];
        const label = this._lyricLabels[index];
        if (!line?.words?.length || !label || states.length !== line.words.length)
            return;

        const signature = `${index}:${states.join(',')}`;
        if (signature === this._wordStateSignature)
            return;
        this._wordStateSignature = signature;

        const markup = line.words.map((word, wordIndex) => {
            const text = GLib.markup_escape_text(word.text, -1);
            switch (states[wordIndex]) {
            case 'past':
                return `<span alpha="72%">${text}</span>`;
            case 'current':
                return `<span weight="semibold">${text}</span>`;
            default:
                return `<span alpha="48%">${text}</span>`;
            }
        }).join('');
        label.clutter_text.set_markup(markup);
    }

    isPopupOpen() {
        return Boolean(this.actor?.menu?.isOpen);
    }

    setOffsets(trackOffsetMs, globalOffsetMs) {
        const format = offsetMs => {
            const seconds = offsetMs / 1000;
            const value = `${seconds >= 0 ? '+' : ''}${seconds.toFixed(1)}`;
            return _('%s s').format(value);
        };
        this._offsetLabel.text = format(trackOffsetMs);
        this._effectiveOffsetLabel.text = _('Global %s  ·  Effective %s')
            .format(
                format(globalOffsetMs),
                format(trackOffsetMs + globalOffsetMs));
        this._effectiveOffsetLabel.visible = globalOffsetMs !== 0;
        setButtonEnabled(
            this._decreaseButton, trackOffsetMs > MIN_OFFSET_MS);
        setButtonEnabled(
            this._increaseButton, trackOffsetMs < MAX_OFFSET_MS);
        setButtonEnabled(this._resetButton, trackOffsetMs !== 0);
    }

    setMaxPanelWidth(width) {
        this._maxPanelWidth = Math.clamp(Math.round(width), 150, 1000);
        this._applyPanelWidth();
    }

    setShowIcon(visible) {
        this._showIcon = Boolean(visible);
        this._icon.visible = this._showIcon || !this._label.text;
        this._applyPanelWidth();
    }

    setPlayers(players, preferredPlayer) {
        this._playerMenu.menu.removeAll();
        const autoItem = this._playerMenu.menu.addAction(_('Auto'), () => {
            this._onPlayerSelected?.('auto');
        });
        autoItem.setOrnament(preferredPlayer === 'auto'
            ? PopupMenu.Ornament.CHECK
            : PopupMenu.Ornament.NONE);

        const seen = new Set();
        for (const player of players) {
            if (seen.has(player.stableId))
                continue;
            seen.add(player.stableId);
            const item = this._playerMenu.menu.addAction(
                player.displayName, () => {
                    this._onPlayerSelected?.(player.stableId);
                });
            item.setOrnament(player.stableId === preferredPlayer
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }

        const selected = players.find(player => player.selected);
        const playerLabel = GLib.markup_escape_text(_('Player'), -1);
        if (selected) {
            const displayName = GLib.markup_escape_text(
                selected.displayName, -1);
            this._playerMenu.label.clutter_text.set_markup(
                `<span size="smaller" alpha="58%">${playerLabel}</span>` +
                `   ${displayName}`);
            this._playerMenu.accessible_name = _('Player: %s')
                .format(selected.displayName);
        } else {
            this._playerMenu.label.clutter_text.set_markup(
                `<span size="smaller" alpha="58%">${playerLabel}</span>`);
            this._playerMenu.accessible_name = _('Player');
        }
    }

    setVisible(visible) {
        if (!this.actor)
            return;

        if (visible) {
            const wasVisible = this.actor.visible;
            this.actor.container.show();
            this.actor.show();
            if (!wasVisible)
                this._schedulePanelPan();
        } else {
            this._cancelPanelPan();
            this.actor.hide();
            this.actor.container.hide();
        }
    }

    _showLyricsMessage(text) {
        this._clearLyricsRows();
        const message = new St.Label({
            style_class: 'lyric-glance-message',
            text,
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        message.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        message.clutter_text.set_line_wrap(true);
        message.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._lyricsBox.add_child(message);
        this._messageLabel = message;
        this._updateTranslationControlVisibility();
    }

    _applyLineVisualLevels(previousIndex, currentIndex, animate) {
        for (let index = 0; index < this._lyricRows.length; index++) {
            const row = this._lyricRows[index];
            const level = getLineVisualLevel(index, currentIndex);
            for (const className of LINE_VISUAL_CLASS_NAMES)
                row.remove_style_class_name(className);
            row.add_style_class_name(`lyric-glance-line-${level.name}`);

            row.remove_all_transitions();
            if (animate && (index === previousIndex || index === currentIndex)) {
                row.ease({
                    opacity: level.opacity,
                    duration: LYRIC_TRANSITION_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                row.opacity = level.opacity;
            }
        }
    }

    _applyPanelWidth() {
        if (!this._labelViewport || !this._panelBox)
            return;
        // Stop an active translation before width/style invalidation. A
        // running transition can otherwise request a stage-view update while
        // the panel hierarchy is waiting for its new allocation.
        this._cancelPanelPan();
        const reservedForIcon = this._icon.visible ? 22 : 0;
        const preferredWidth = Math.min(
            this._labelViewport.visible ? PANEL_PREFERRED_WIDTH : 22,
            this._maxPanelWidth);
        const labelWidth = Math.max(1,
            preferredWidth - reservedForIcon);
        this._panelBox.natural_width = preferredWidth;
        this._panelBox.set_style(`max-width: ${this._maxPanelWidth}px;`);
        this._labelViewport.set_style(`max-width: ${labelWidth}px;`);
        // A preference or icon change can leave the allocated width unchanged
        // under external constraints. Restart after layout even when no width
        // notification arrives, since the active pan was cancelled above.
        this._queuePanelPanRestart();
    }

    _setPanelPlaying(playing) {
        if (this._panelPlaying === playing)
            return;
        const nowUs = GLib.get_monotonic_time();
        if (this._panelPanTimeline) {
            this._panelPanTimeline = {
                ...this._panelPanTimeline,
                positionMs: this._panelPanPositionAt(nowUs),
            };
            this._panelPanTimelineAnchorUs = nowUs;
        }
        this._panelPlaying = playing;
        if (this._panelPanLooping) {
            if (playing)
                this._resumePanelPan();
            else
                this._pausePanelPan();
            return;
        }
        this._schedulePanelPan();
    }

    _schedulePanelPan() {
        this._cancelPanelPan({preserveDisplay:
            this._panelPanLabel.visible && this._panelPanScrollable &&
            Boolean(this._panelPanTimeline || this._panelPanLooping)});
        this._label.clutter_text.set_ellipsize(
            this._panelPanScrollable && (this._panelPanTimeline ||
                (this._panelPanLooping && this._animationsEnabled()))
                ? Pango.EllipsizeMode.NONE
                : Pango.EllipsizeMode.END);
        this._updatePanelFade();
        this._queuePanelPan();
    }

    _updatePanelFade() {
        const width = this._panelViewportWidth;
        const [, textWidth] = this._panelPanLabel.get_preferred_width(-1);
        const active = this._panelPanScrollable &&
            (this._panelPanTimeline || this._panelPanLooping) &&
            this._animationsEnabled() && width > 0 && textWidth > width + 1;
        this._panelFadeEffect.enabled = Boolean(active);
        if (active) {
            this._panelFadeEffect.setEdges(width,
                this._panelPanLabel.visible
                    ? this._panelPanLabel.translation_x : 0,
                textWidth);
        }
    }

    _queuePanelPan() {
        if (!this._panelPanScrollable ||
            (!this._panelPanTimeline && !this._panelPanLooping) ||
            !this._labelViewport?.mapped)
            return;

        this._panelPanLaterId = this._laters.add(
            Meta.LaterType.IDLE,
            () => {
                this._panelPanLaterId = 0;
                this._startPanelPan();
                return GLib.SOURCE_REMOVE;
            });
    }

    _queuePanelPanRestart() {
        if (!this._panelPanScrollable ||
            (!this._panelPanTimeline && !this._panelPanLooping) ||
            !this._labelViewport?.mapped)
            return;
        // Style/font and allocation changes must restart outside allocation.
        if (this._panelPanLaterId)
            this._laters.remove(this._panelPanLaterId);
        this._panelPanLaterId = this._laters.add(Meta.LaterType.IDLE, () => {
            this._panelPanLaterId = 0;
            this._panelWordGeometry = null;
            this._schedulePanelPan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _queuePanelGeometryCheck() {
        if (this._panelGeometryLaterId || !this._panelPanScrollable ||
            (!this._panelPanTimeline && !this._panelPanLooping) ||
            !this._labelViewport?.mapped)
            return;
        this._panelGeometryLaterId = this._laters.add(Meta.LaterType.IDLE, () => {
            this._panelGeometryLaterId = 0;
            if (!this._panelPanScrollable ||
                (!this._panelPanTimeline && !this._panelPanLooping) ||
                !this._labelViewport?.mapped)
                return GLib.SOURCE_REMOVE;
            this._panelPanLabel.ensure_style();
            const [, width] = this._panelPanLabel.get_preferred_width(-1);
            const fontKey = this._panelPanLabel.get_theme_node().get_font().to_string() +
                '/' + this._panelPanLabel.clutter_text.get_resource_scale();
            if (Math.abs(width - this._panelNaturalWidth) > 0.5 ||
                fontKey !== this._panelFontKey) {
                this._panelWordGeometry = null;
                this._schedulePanelPan();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _startPanelPan() {
        if (this._panelWordTimeoutId) {
            GLib.source_remove(this._panelWordTimeoutId);
            this._panelWordTimeoutId = 0;
        }
        if (!this._panelPanScrollable ||
            (!this._panelPanTimeline && !this._panelPanLooping) ||
            !this._labelViewport?.mapped)
            return;
        if (this._panelPanLooping && !this._animationsEnabled()) {
            this._cancelPanelPan();
            return;
        }

        const [, naturalWidth] =
            this._panelPanLabel.get_preferred_width(-1);
        this._panelNaturalWidth = naturalWidth;
        this._panelFontKey = this._panelPanLabel.get_theme_node().get_font().to_string() +
            '/' + this._panelPanLabel.clutter_text.get_resource_scale();
        // Actor.width may report a preferred width while layout is invalid.
        // Only allocation notifications provide the actual text viewport.
        const viewportWidth = this._panelViewportWidth;
        const overflow = Math.ceil(naturalWidth - viewportWidth);
        if (!(viewportWidth > 0) || overflow <= 0) {
            this._cancelPanelPan();
            this._updatePanelFade();
            return;
        }

        // Changing the custom layout invalidates the actor hierarchy. Let
        // Clutter allocate the full-width pan label before changing visibility
        // or starting a transition; doing both in one frame floods the Shell
        // journal with "needs an allocation" warnings.
        if (this._panelLabelLayout.setPanWidth(naturalWidth)) {
            this._panelPanLaterId = this._laters.add(
                Meta.LaterType.IDLE,
                () => {
                    this._panelPanLaterId = 0;
                    this._startPanelPan();
                    return GLib.SOURCE_REMOVE;
                });
            return;
        }
        if (this._panelPanLooping) {
            this._panelPanLabel.remove_all_transitions();
            this._panelPanLabel.translation_x = 0;
            this._panelPanLabel.show();
            this._label.hide();
            this._updatePanelFade();
            this._panelPanTargetX = -(overflow + PANEL_PAN_END_PADDING);
            this._continuePanelTitlePan(1000);
            return;
        }
        const panState = this._panelPanState(this._panelPanPositionAt());
        if (!panState)
            return;
        this._panelPanLabel.remove_all_transitions();
        this._panelPanLabel.translation_x = panState.initialX;
        this._panelPanLabel.show();
        this._label.hide();
        this._updatePanelFade();
        this._panelPanTargetX = panState.targetX;
        const shouldAnimate = this._panelPlaying && panState.shouldAnimate;
        if (shouldAnimate) {
            this._panelPanLabel.ease({
                translation_x: this._panelPanTargetX,
                delay: panState.delayMs,
                duration: panState.durationMs,
                mode: Clutter.AnimationMode.LINEAR,
            });
        }
        const hoverPaused = this._panelHovered && !this.actor.menu.isOpen;
        if (this._panelPlaying && panState.nextMs && !hoverPaused) {
            this._panelWordTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Math.max(1, Math.ceil((panState.nextMs - this._panelPanPositionAt()) /
                    this._panelPanTimeline.playbackRate)), () => {
                    this._panelWordTimeoutId = 0;
                    this._startPanelPan();
                    return GLib.SOURCE_REMOVE;
                });
        }
        if (hoverPaused && shouldAnimate)
            this._pausePanelPan();
        else if (hoverPaused && panState.nextMs)
            this._panelPanPaused = true;
    }

    _panelPanState(positionMs) {
        const [, naturalWidth] = this._panelPanLabel.get_preferred_width(-1);
        const width = this._panelViewportWidth;
        const overflow = Math.ceil(naturalWidth - width);
        const distance = overflow <= PANEL_PAN_END_PADDING
            ? overflow : overflow + PANEL_PAN_END_PADDING;
        if (!this._animationsEnabled())
            return panelPanState(this._panelPanTimeline, positionMs,
                distance, Math.max(1, width * 0.8));
        if (overflow > PANEL_PAN_END_PADDING &&
            this._wordSyncEnabled && this._panelWords?.length) {
            const layout = this._panelPanLabel.clutter_text.get_layout();
            const serial = layout.get_serial();
            const resourceScale = this._panelPanLabel.clutter_text.get_resource_scale();
            if (this._panelWordGeometry?.serial !== serial ||
                this._panelWordGeometry.endMs !== this._panelPanTimeline.endMs ||
                this._panelWordGeometry.scale !== resourceScale) {
                let byteIndex = 0;
                let previousEndMs = this._panelPanTimeline.startMs;
                let previousEndX = 0;
                const measured = [];
                const encoder = new TextEncoder();
                const words = this._panelWords;
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
                    characterByte += encoder.encode(character).length;
                }
                for (let index = 0; valid && index < words.length; index++) {
                    const word = words[index];
                    const start = layout.index_to_pos(byteIndex);
                    byteIndex += encoder.encode(word.text).length;
                    const end = layout.index_to_pos(byteIndex);
                    const startX = start.x / Pango.SCALE / resourceScale;
                    const endX = end.x / Pango.SCALE / resourceScale;
                    const endMs = word.endMs ?? words[index + 1]?.startMs ??
                        this._panelPanTimeline.endMs;
                    valid = Number.isFinite(word.startMs) && Number.isFinite(endMs) &&
                        word.startMs >= previousEndMs && endMs > word.startMs &&
                        endMs <= this._panelPanTimeline.endMs && start.width >= 0 &&
                        startX >= previousEndX && endX > startX;
                    measured.push({startMs: word.startMs, endMs, startX, endX});
                    previousEndMs = endMs;
                    previousEndX = endX;
                }
                this._panelWordGeometry = {serial,
                    scale: resourceScale,
                    endMs: this._panelPanTimeline.endMs,
                    words: valid ? measured : null};
            }
            const state = wordPanState(this._panelPanTimeline, positionMs,
                this._panelWordGeometry.words, width, distance);
            if (state)
                return state;
        }
        return panelPanState(this._panelPanTimeline, positionMs, distance);
    }

    _continuePanelTitlePan(delayMs = 0) {
        if (!this._panelPanLooping || !this._panelPanLabel.visible ||
            !this._labelViewport.mapped || !this._animationsEnabled())
            return;
        if (!this._panelPlaying || (this._panelHovered && !this.actor.menu.isOpen)) {
            this._panelPanPaused = true;
            return;
        }
        const outward = this._panelPanTargetX < 0;
        const distance = Math.abs(this._panelPanTargetX - this._panelPanLabel.translation_x);
        this._panelPanLabel.ease({
            translation_x: this._panelPanTargetX,
            delay: delayMs,
            duration: Math.max(outward ? 1000 : 600,
                Math.round(distance / (outward ? 35 : 70) * 1000)),
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => {
                this._panelPanTargetX = outward ? 0 :
                    -(Math.ceil(this._panelNaturalWidth - this._panelViewportWidth) +
                        PANEL_PAN_END_PADDING);
                this._continuePanelTitlePan(outward ? 1200 : 1000);
            },
        });
    }

    _queueTitlePan() {
        if (this._titlePanLaterId)
            this._laters.remove(this._titlePanLaterId);
        this._titlePanLaterId = 0;
        if (!this.actor.menu.isOpen)
            return;
        this._titlePanLaterId = this._laters.add(Meta.LaterType.IDLE, () => {
            this._titlePanLaterId = 0;
            this._startTitlePan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startTitlePan() {
        this._titleLabel.remove_all_transitions();
        this._titleLabel.translation_x = 0;
        const animate = this._animationsEnabled();
        const wasEllipsized = this._titleLabel.clutter_text.get_ellipsize() !==
            Pango.EllipsizeMode.NONE;
        this._titleLabel.clutter_text.set_ellipsize(animate
            ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END);
        if (!animate || !this.actor.menu.isOpen || !this._titleViewport.mapped)
            return;
        const [, naturalWidth] = this._titleLabel.get_preferred_width(-1);
        const overflow = Math.ceil(naturalWidth - this._titleViewportWidth);
        if (!(this._titleViewportWidth > 0))
            return;
        if (overflow <= 0)
            return;
        // Wait for the unellipsized title to receive its full allocation.
        if (this._titleLabel.width < naturalWidth - 0.5) {
            if (wasEllipsized)
                this._queueTitlePan();
            return;
        }
        const distance = overflow + 8;
        this._titleLabel.ease({
            translation_x: -distance, delay: 1000,
            duration: Math.max(1000, Math.round(distance / 35 * 1000)),
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => this._titleLabel.ease({
                translation_x: 0, delay: 1200,
                duration: Math.max(600, Math.round(distance / 70 * 1000)),
                mode: Clutter.AnimationMode.LINEAR,
                onComplete: () => this._startTitlePan(),
            }),
        });
    }

    _cancelTitlePan() {
        if (this._titlePanLaterId) {
            this._laters.remove(this._titlePanLaterId);
            this._titlePanLaterId = 0;
        }
        this._titleLabel?.remove_all_transitions();
        if (this._titleLabel)
            this._titleLabel.translation_x = 0;
    }

    _panelPanPositionAt(nowUs = GLib.get_monotonic_time()) {
        const timeline = this._panelPanTimeline;
        if (!timeline)
            return 0;
        const elapsedMs = this._panelPlaying &&
            this._panelPanTimelineAnchorUs > 0
            ? Math.max(0, nowUs - this._panelPanTimelineAnchorUs) / 1000 *
                timeline.playbackRate
            : 0;
        return Math.min(timeline.endMs, timeline.positionMs + elapsedMs);
    }

    _cancelPanelPan({preserveDisplay = false} = {}) {
        if (this._panelGeometryLaterId) {
            this._laters.remove(this._panelGeometryLaterId);
            this._panelGeometryLaterId = 0;
        }
        if (this._panelWordTimeoutId) {
            GLib.source_remove(this._panelWordTimeoutId);
            this._panelWordTimeoutId = 0;
        }
        if (this._panelPanLaterId && this._laters) {
            this._laters.remove(this._panelPanLaterId);
            this._panelPanLaterId = 0;
        }
        this._panelPanLabel?.remove_all_transitions();
        if (this._panelPanLabel && !preserveDisplay) {
            this._panelPanLabel.translation_x = 0;
            this._panelPanLabel.hide();
        }
        if (!preserveDisplay)
            this._label?.show();
        this._panelPanTargetX = 0;
        this._panelPanPaused = false;
    }

    _pausePanelPan() {
        const hadWordTimer = Boolean(this._panelWordTimeoutId);
        if (hadWordTimer) {
            GLib.source_remove(this._panelWordTimeoutId);
            this._panelWordTimeoutId = 0;
            this._panelPanPaused = true;
        }
        const transition =
            this._panelPanLabel?.get_transition('translation-x');
        if (!transition)
            return;
        const currentX = this._panelPanLabel.translation_x;
        this._panelPanLabel.remove_transition('translation-x');
        this._panelPanLabel.translation_x = currentX;
        this._panelPanPaused =
            this._panelPanLooping || hadWordTimer || currentX > this._panelPanTargetX;
    }

    _resumePanelPan() {
        if (!this._panelPanPaused || !this._panelPlaying ||
            !this._panelPanLabel?.visible)
            return;
        this._panelPanPaused = false;
        if (!this._animationsEnabled()) {
            this._schedulePanelPan();
            return;
        }
        if (this._panelPanLooping) {
            this._continuePanelTitlePan();
            return;
        }
        // Catch the timeline where it will be when the transition finishes,
        // rather than chasing a position already in the past.
        const panState = this._panelPanState(
            this._panelPanPositionAt(GLib.get_monotonic_time() +
                PANEL_PAN_CATCH_UP_MS * 1000));
        if (!panState)
            return;
        this._panelPanLabel.ease({
            translation_x: panState.initialX,
            duration: PANEL_PAN_CATCH_UP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._startPanelPan(),
        });
    }

    _clearLyricsRows() {
        this._cancelScheduledScroll();
        this._cancelLayoutAnchor();
        this._lyricsBox.destroy_all_children();
        this._lyricRows = [];
        this._lyricLabels = [];
        this._translationLabels = [];
        this._activeLyricIndex = -1;
        this._wordStateSignature = '';
        this._messageLabel = null;
    }

    _applyTranslationToRows() {
        if (!this._document?.lines?.length)
            return;
        const anchor = this._captureActiveRowAnchor();
        const translations = new Map(
            this._translationDocument?.lines?.map(line =>
                [line.lineId, line.text]) ?? []);
        for (let index = 0; index < this._document.lines.length; index++) {
            const original = this._lyricLabels[index];
            const translated = this._translationLabels[index];
            if (!original || !translated)
                continue;
            const text = translations.get(this._document.lines[index].lineId);
            const hasTranslation = this._translationEnabled &&
                typeof text === 'string' && Boolean(text);
            if (hasTranslation && translated.text !== text)
                translated.text = text;

            translated.remove_style_class_name(
                'lyric-glance-translation-only');
            switch (this._translationDisplayMode) {
            case 'original':
                original.show();
                translated.hide();
                break;
            case 'translated':
                original.visible = !hasTranslation;
                translated.visible = hasTranslation;
                if (hasTranslation)
                    translated.add_style_class_name(
                        'lyric-glance-translation-only');
                break;
            default:
                original.show();
                translated.visible = hasTranslation;
                break;
            }
        }
        this._queueActiveRowAnchor(anchor);
    }

    _updateTranslationControlVisibility() {
        if (!this._translationItem)
            return;
        this._translationItem.visible = this._translationEnabled &&
            Boolean(this._document?.lines?.length) &&
            !this._document?.instrumental &&
            this._translationStatus !== 'skipped';
    }

    _resetLineText(index) {
        const label = this._lyricLabels[index];
        const line = this._document?.lines?.[index];
        if (label && line)
            label.clutter_text.set_text(line.text);
    }

    _scheduleScrollToActive({force = false, immediate = false} = {}) {
        if (!this.actor.menu.isOpen ||
            !this._lyricRows[this._activeLyricIndex])
            return;

        this._scrollView.vadjustment.remove_transition('value');
        this._scrollRequest = {force, immediate};
        if (this._scrollLaterId)
            return;

        this._scrollLaterId = this._laters.add(
            Meta.LaterType.IDLE,
            () => {
                this._scrollLaterId = 0;
                const request = this._scrollRequest;
                this._scrollRequest = null;
                this._scrollToActive(request);
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelScheduledScroll() {
        if (this._scrollLaterId) {
            this._laters.remove(this._scrollLaterId);
            this._scrollLaterId = 0;
        }
        this._scrollRequest = null;
        this._scrollView?.vadjustment?.remove_transition('value');
    }

    _scrollToActive({force = false, immediate = false} = {}) {
        if (!this.actor.menu.isOpen)
            return;

        const row = this._lyricRows[this._activeLyricIndex];
        if (!row)
            return;

        const adjustment = this._scrollView.vadjustment;
        const [value, lower, upper, , , pageSize] = adjustment.get_values();
        if (pageSize <= 0)
            return;

        const bounds = this._rowVerticalBounds(row);
        if (!bounds)
            return;
        const target = comfortableScrollTarget({
            rowTop: bounds.y1,
            rowBottom: bounds.y2,
            value,
            lower,
            upper,
            pageSize,
            force,
        });
        if (target === null || Math.abs(target - value) < 0.5)
            return;

        adjustment.remove_transition('value');
        if (immediate || !this._animationsEnabled()) {
            adjustment.set_value(target);
        } else {
            adjustment.ease(target, {
                duration: SCROLL_TRANSITION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _rowVerticalBounds(row) {
        let box = row.get_allocation_box();
        let y1 = box.y1;
        let y2 = box.y2;
        let parent = row.get_parent();
        while (parent !== this._scrollView) {
            if (!parent)
                return null;

            box = parent.get_allocation_box();
            y1 += box.y1;
            y2 += box.y1;
            parent = parent.get_parent();
        }
        return {y1, y2};
    }

    _captureActiveRowAnchor() {
        if (!this.actor.menu.isOpen)
            return null;
        const row = this._lyricRows[this._activeLyricIndex];
        if (!row)
            return null;
        const [, stageY] = row.get_transformed_position();
        return {row, stageY};
    }

    _queueActiveRowAnchor(anchor) {
        if (!anchor)
            return;
        this._cancelLayoutAnchor();
        const adjustment = this._scrollView.vadjustment;
        this._layoutAnchorAdjustment = adjustment;
        this._layoutAnchorSignalId = adjustment.connect(
            'notify::upper', () => {
                this._cancelLayoutAnchor();
                if (!this.actor.menu.isOpen ||
                    anchor.row !== this._lyricRows[this._activeLyricIndex])
                    return;

                const [, stageY] = anchor.row.get_transformed_position();
                const delta = stageY - anchor.stageY;
                if (Math.abs(delta) < 0.5)
                    return;

                const [, lower, upper, , , pageSize] = adjustment.get_values();
                const maximum = Math.max(lower, upper - pageSize);
                adjustment.remove_transition('value');
                adjustment.set_value(Math.min(maximum, Math.max(
                    lower, adjustment.value + delta)));
            });
    }

    _cancelLayoutAnchor() {
        if (this._layoutAnchorSignalId && this._layoutAnchorAdjustment)
            this._layoutAnchorAdjustment.disconnect(this._layoutAnchorSignalId);
        this._layoutAnchorSignalId = 0;
        this._layoutAnchorAdjustment = null;
    }

    destroy() {
        this._cancelPanelPan();
        this._cancelTitlePan();
        if (this._titleAnimationSignalId)
            this._titleAnimationSettings.disconnect(this._titleAnimationSignalId);
        this._titleAnimationSignalId = 0;
        this._titleAnimationSettings = null;
        this._cancelScheduledScroll();
        this._cancelLayoutAnchor();
        this._label?.remove_all_transitions();
        this._onOffsetAdjust = null;
        this._onOffsetReset = null;
        this._onPlayerSelected = null;
        this._onPopupOpenChanged = null;
        this._onTranslationAction = null;
        this._onMediaControl = null;
        this._mediaRequest++;
        this._mediaState = null;
        this._mediaTarget = null;
        this._mediaButtons = null;
        this._mediaErrorLabel = null;
        this._animationsEnabled = null;
        this._artworkView?.destroy();
        this._progressView?.destroy();
        this.actor?.destroy();
        this.actor = null;
        this._panelBox = null;
        this._icon = null;
        this._label = null;
        this._panelPanLabel = null;
        this._panelLabelLayout = null;
        this._panelFadeEffect = null;
        this._labelViewport = null;
        this._panelPanTimeline = null;
        this._panelWords = null;
        this._panelWordGeometry = null;
        this._titleLabel = null;
        this._titleViewport = null;
        this._artistLabel = null;
        this._albumLabel = null;
        this._artworkView = null;
        this._progressView = null;
        this._lyricsSourceItem = null;
        this._lyricsSourceLabel = null;
        this._lyricsBox = null;
        this._scrollView = null;
        this._laters = null;
        this._lyricRows = [];
        this._lyricLabels = [];
        this._translationLabels = [];
        this._document = null;
        this._translationDocument = null;
        this._offsetLabel = null;
        this._effectiveOffsetLabel = null;
        this._decreaseButton = null;
        this._increaseButton = null;
        this._resetButton = null;
        this._playerMenu = null;
        this._translationItem = null;
        this._translationStatusLabel = null;
        this._translationActionButton = null;
    }
}
