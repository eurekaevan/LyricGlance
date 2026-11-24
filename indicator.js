import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ArtworkView} from './artwork-view.js';
import {
    MAX_LAYOUT_WAIT_RETRIES,
    PanelLabelLayout,
    PanelLabelView,
    TITLE_LOOP_GAP,
    createTitleCopy,
    loopTitle,
    measureLabelText,
} from './panel-label-view.js';
import {animationsEnabled, musicIcon} from './shell-ui-utils.js';
import {
    comfortableScrollTarget,
    formatDuration,
    getLineVisualLevel,
    translationNetworkErrorText,
} from './ui-utils.js';

const OFFSET_STEP_MS = 500;
const MIN_OFFSET_MS = -10_000;
const MAX_OFFSET_MS = 10_000;
const LYRIC_TRANSITION_MS = 160;
const SCROLL_TRANSITION_MS = 220;

function sameControlTarget(a, b) {
    return a === b || Boolean(a && b && a.busName === b.busName &&
        a.generation === b.generation && a.trackKey === b.trackKey);
}

function configureEllipsized(label) {
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    label.clutter_text.set_single_line_mode(true);
}

function createMetadataLabel(styleClass) {
    const label = new St.Label({
        style_class: styleClass,
        text: '',
        x_expand: true,
        y_align: Clutter.ActorAlign.START,
    });
    configureEllipsized(label);
    return label;
}

function setButtonEnabled(button, enabled) {
    button.reactive = enabled;
    button.can_focus = enabled;
    if (enabled)
        button.remove_style_pseudo_class('insensitive');
    else
        button.add_style_pseudo_class('insensitive');
}

class PlaybackProgressView {
    constructor({onSeek} = {}) {
        this._onSeek = onSeek;
        this._target = null;
        this._dragTarget = null;
        this._dragging = false;
        this._updating = false;
        this._seekPending = false;
        this._positionUs = 0;
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
        this._slider.connectObject('drag-begin', () => {
            this._dragging = true;
            this._dragTarget = this._slider.reactive ? this._target : null;
        }, this.actor);
        this._slider.connectObject('drag-end', () => {
            const target = this._dragTarget;
            this._dragging = false;
            this._dragTarget = null;
            if (target && this._slider.reactive)
                this._onSeek?.(target, this._slider.value * this._durationUs);
            else
                this._renderProgress();
        }, this.actor);
        this._slider.connectObject('notify::value', () => {
            if (this._updating || !this._slider.reactive)
                return;
            this._currentLabel.text = formatDuration(
                this._slider.value * this._durationUs / 1_000_000);
            if (!this._dragging)
                this._onSeek?.(this._target, this._slider.value * this._durationUs);
        }, this.actor);
        this.actor.hide();
    }

    setControlState(target, enabled, {busy = false} = {}) {
        if (!sameControlTarget(target, this._target)) {
            this.cancelDrag();
            this.setSeekPending(false);
        } else if (!enabled || busy) {
            this.cancelDrag();
        }
        this._target = target;
        if (!enabled) {
            setButtonEnabled(this._slider, false);
        } else if (busy) {
            // Keep keyboard focus on the slider during in-flight seeks so
            // repeated arrow-key stepping does not jump focus away.
            this._slider.reactive = false;
            this._slider.can_focus = true;
            this._slider.remove_style_pseudo_class('insensitive');
        } else {
            setButtonEnabled(this._slider, true);
        }
    }

    setSeekPending(pending) {
        this._seekPending = pending;
        if (!pending)
            this._renderProgress();
    }

    cancelDrag() {
        // Leave the gesture active until its release, but never commit it.
        this._dragTarget = null;
    }

    setProgress(positionUs, durationUs) {
        const duration = Number(durationUs);
        this._durationUs = Number.isFinite(duration) && duration > 0 ? duration : 0;
        this._positionUs = Number(positionUs) || 0;
        this.actor.visible = this._durationUs > 0;
        this._durationLabel.text = formatDuration(this._durationUs / 1_000_000);
        this._renderProgress();
    }

    _renderProgress() {
        if (this._seekPending || this._dragging && this._dragTarget)
            return;
        const position = Math.min(Math.max(0, this._positionUs),
            this._durationUs);
        this._updating = true;
        // Shell 50/51 retain a separate step origin after user interaction.
        this._slider._unsnappedValue = null;
        this._slider.value = this._durationUs > 0 ? position / this._durationUs : 0;
        this._updating = false;
        this._currentLabel.text = formatDuration(position / 1_000_000);
    }

    destroy() {
        this.cancelDrag();
        this._seekPending = false;
        this._onSeek = null;
        this._target = null;
        this._slider?.disconnectObject(this.actor);
        this._currentLabel?.destroy();
        this._durationLabel?.destroy();
        this.actor?.destroy();
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
        this._menuFocusSignalId = 0;
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
        this._scrollStageSignalId = 0;
        this._scrollRequest = null;
        this._scrollRetries = 0;
        this._layoutAnchorSignalId = 0;
        this._layoutAnchorAdjustment = null;
        this._titlePanLaterId = 0;
        this._titlePanRetries = 0;
        this._titlePanPeriod = 0;
        this._titleViewportWidth = 0;
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
        this._panelLabelView = new PanelLabelView({
            animationsEnabled: this._animationsEnabled,
            isMenuOpen: () => Boolean(this.actor?.menu?.isOpen),
        });
        this.actor.connect('enter-event', () => {
            this._panelLabelView?.setHovered(true);
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('leave-event', () => {
            this._panelLabelView?.setHovered(false);
            return Clutter.EVENT_PROPAGATE;
        });
        this._panelBox.add_child(this._icon);
        this._panelBox.add_child(this._panelLabelView.actor);
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
            reactive: true, track_hover: true,
            layout_manager: new PanelLabelLayout(),
        });
        this._titleViewport.add_child(this._titleLabel);
        this._titleViewport.layout_manager.setPanLabel(this._titleLabel);
        this._titleCopy = createTitleCopy(this._titleLabel, this._titleViewport);
        this._titleViewport.connect('notify::hover', () => {
            if (this._titleViewport.hover) {
                const x = this._titleLabel.translation_x;
                this._titleLabel.remove_all_transitions();
                this._titleLabel.translation_x = x;
            } else if (this._titleCopy.visible) {
                this._continueTitlePan();
            }
        });
        this._titleLabel.connect('style-changed', () => {
            this._titlePanRetries = 0;
            this._queueTitlePan();
        });
        this._titleLabel.clutter_text.connect('resource-scale-changed', () => {
            this._titlePanRetries = 0;
            this._queueTitlePan();
        });
        let titleAllocatedWidth = 0;
        this._titleLabel.connect('notify::allocation', () => {
            const width = this._titleLabel.get_allocation_box().get_width();
            if (width === titleAllocatedWidth)
                return;
            titleAllocatedWidth = width;
            this._titlePanRetries = 0;
            this._queueTitlePan();
        });
        this._titleViewport.connect('notify::mapped', () => {
            if (this._titleViewport.mapped) {
                this._titlePanRetries = 0;
                this._queueTitlePan();
            } else {
                this._cancelTitlePan();
            }
        });
        this._titleAnimationSettings = St.Settings.get();
        this._titleAnimationSignalIds = ['enable-animations',
            ...(St.ReducedMotion ? ['reduced-motion'] : [])].map(property =>
            this._titleAnimationSettings.connect(`notify::${property}`, () => {
                this._cancelTitlePan();
                this._queueTitlePan();
                this._panelLabelView?.schedule();
            }));
        this._titleViewport.connect('notify::allocation', () => {
            const width = this._titleViewport.get_allocation_box().get_width();
            if (width === this._titleViewportWidth)
                return;
            this._titleViewportWidth = width;
            this._titlePanRetries = 0;
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
            label: _('%s s').format('−0.5'),
            can_focus: true,
            accessible_name: _('Decrease lyrics offset by 0.5 seconds'),
        });
        this._offsetLabel = new St.Label({
            style_class: 'lyric-glance-offset-label',
            text: _('%s s').format('+0.0'),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._increaseButton = new St.Button({
            style_class: 'button flat lyric-glance-offset-button',
            label: _('%s s').format('+0.5'),
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
                forceRefresh: this._translationStatus === 'available' ||
                    Boolean(this._translationDocument),
                ignoreSameLanguage: this._translationStatus === 'same_language',
            });
        });
        // Preserve a readable lyrics viewport on small displays. The outer
        // scroller takes over once the complete menu cannot fit the work area.
        const menuBox = this.actor.menu.box;
        const menuBin = menuBox.get_parent();
        menuBin.set_child(null);
        this._menuScrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: menuBox,
        });
        menuBin.set_child(this._menuScrollView);
        this._menuFocusSignalId = global.stage.connect('notify::key-focus', () => {
            const focus = global.stage.key_focus;
            if (!this.actor.menu.isOpen || !focus || !this._menuScrollView.contains(focus) ||
                !focus.has_allocation())
                return;
            const [, y] = focus.get_transformed_position();
            const [, height] = focus.get_transformed_size();
            const [, top] = this._menuScrollView.get_transformed_position();
            const [, viewportHeight] = this._menuScrollView.get_transformed_size();
            if (!(viewportHeight > 0))
                return;
            const delta = y < top ? y - top : Math.max(0, y + height - top - viewportHeight);
            const adjustment = this._menuScrollView.vadjustment;
            adjustment.value = Math.max(adjustment.lower, Math.min(
                adjustment.upper - adjustment.page_size,
                adjustment.value + delta * this._menuScrollView.height / viewportHeight));
        });
        this.actor.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                const monitor = Main.layoutManager.findMonitorForActor(this.actor) ??
                    Main.layoutManager.primaryMonitor;
                if (monitor) {
                    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
                    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                    const margins = this.actor.menu.actor.margin_top +
                        this.actor.menu.actor.margin_bottom;
                    this.actor.menu.actor.style = `max-height: ${Math.max(1,
                        Math.floor((workArea.height - margins) / scale))}px;`;
                }
                this._menuScrollView.vadjustment.value = 0;
                this._scheduleScrollToActive({force: true, immediate: true});
                this._panelLabelView?.onMenuOpenChanged(true);
                this._titlePanRetries = 0;
                this._queueTitlePan();
            } else {
                this._cancelScheduledScroll();
                this._cancelTitlePan();
                this._panelLabelView?.onMenuOpenChanged(false);
            }
            this._onPopupOpenChanged?.(open);
        });

        this.setOffsets(0, 0);
        this.setPlayers([], 'auto');
        this.setTranslationEnabled(false);
        this._showLyricsMessage(_('No lyrics found'));
    }

    setText(text, options = {}) {
        this._icon.visible = this._showIcon || !text;
        const viewport = this._panelLabelView?.actor;
        if (!viewport)
            return;
        const iconOnly = !text;
        if (viewport.visible === iconOnly) {
            viewport.visible = !iconOnly;
            this._applyPanelWidth();
        }
        this._panelLabelView.setText(text, options);
    }

    setTrack(metadata, trackKey) {
        this.updateMetadataDisplay(metadata);
        this.setArtwork(metadata.artUrl, trackKey);
        this.setProgress(0, metadata.durationUs);
        this._document = null;
        this._translationDocument = null;
        this._lyricsSourceLabel.text = '';
        this._lyricsSourceItem.hide();
        this.setTranslationState('idle');
        this._showLyricsMessage(_('Loading lyrics…'));
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
        if (!sameControlTarget(target, this._mediaTarget)) {
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
        const canSeek = Boolean(target && capabilities.CanControl &&
            capabilities.CanSeek && state.metadata.durationUs > 0 &&
            GLib.Variant.is_object_path(trackId) &&
            trackId !== '/org/mpris/MediaPlayer2/TrackList/NoTrack');
        this._progressView.setControlState(target, canSeek, {
            busy: this._mediaBusy,
        });
    }

    async _requestMediaControl(action, target, positionUs = null) {
        if (!target || !this._onMediaControl || this._mediaBusy)
            return;
        const request = ++this._mediaRequest;
        this._mediaBusy = true;
        this._mediaErrorLabel.hide();
        if (action === 'SetPosition')
            this._progressView.setSeekPending(true);
        this.setMediaState(this._mediaState);
        try {
            const accepted = await this._onMediaControl(action, target, positionUs);
            if (accepted === false && this.actor && request === this._mediaRequest)
                throw new Error('Playback control was rejected');
        } catch (error) {
            if (this.actor && request === this._mediaRequest) {
                this._mediaErrorLabel.show();
                console.warn(`LyricGlance: playback control failed: ${error.message}`);
            }
        } finally {
            if (this.actor && request === this._mediaRequest) {
                this._mediaBusy = false;
                if (action === 'SetPosition')
                    this._progressView.setSeekPending(false);
                this.setMediaState(this._mediaState);
            }
        }
    }

    cancelMediaDrag() {
        this._progressView.cancelDrag();
        this._progressView.setSeekPending(false);
    }

    setProgress(positionUs, durationUs, options = {}) {
        this._progressView?.setProgress(positionUs, durationUs);
        this._panelLabelView?.setPlaying(Boolean(options.playing));
    }

    clearTrack() {
        this._cancelTitlePan();
        this._panelLabelView?.clear();
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

    setTranslationState(status, {fromCache = false, networkReason = null} = {}) {
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
            network_error: [translationNetworkErrorText(networkReason, _), _('Retry'), true],
            provider_error: [_('Translation provider error'), _('Retry'), true],
            authentication_error: [_('Translation API key was rejected'), _('Retry'), true],
            permission_denied: [_('Translation access was denied'), _('Retry'), true],
            quota_exceeded: [_('Translation quota or spending limit reached'), _('Retry'), true],
            rate_limited: [_('Translation rate limited'), _('Retry'), true],
            invalid_response: [_('Translation response was invalid'), _('Retry'), true],
            canceled: [_('Translation canceled'), _('Retry'), true],
            same_language: [
                _('Original language matches target language'),
                _('Translate anyway'),
                true,
            ],
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

        if (current && this.actor.menu.isOpen) {
            this._scheduleScrollToActive({
                force: reposition,
                immediate: reposition,
            });
        } else {
            this._cancelScheduledScroll();
        }
    }

    setWordSyncEnabled(enabled) {
        this._wordSyncEnabled = Boolean(enabled);
        this._wordStateSignature = '';
        if (!this._wordSyncEnabled && this._activeLyricIndex >= 0)
            this._resetLineText(this._activeLyricIndex);
        this._panelLabelView?.setWordSyncEnabled(this._wordSyncEnabled);
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
        this._icon.visible = this._showIcon || !this._panelLabelView?.text;
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
                this._panelLabelView?.schedule();
        } else {
            this._panelLabelView?.cancel();
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
        const fullRefresh = previousIndex < 0 || currentIndex < 0;
        const indices = fullRefresh ? this._lyricRows.keys() : new Set();
        if (!fullRefresh) {
            for (const center of [previousIndex, currentIndex]) {
                for (let index = Math.max(0, center - 2);
                    index <= Math.min(this._lyricRows.length - 1, center + 2); index++)
                    indices.add(index);
            }
        }
        for (const index of indices) {
            const previousLevel = getLineVisualLevel(index, previousIndex);
            const level = getLineVisualLevel(index, currentIndex);
            if (!fullRefresh && previousLevel.name === level.name)
                continue;
            const row = this._lyricRows[index];
            row.remove_style_class_name(`lyric-glance-line-${previousLevel.name}`);
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
        if (!this._panelLabelView?.actor || !this._panelBox)
            return;
        this._panelLabelView.prepareWidthChange();
        const reservedForIcon = this._icon.visible ? 22 : 0;
        const preferredWidth = this._panelLabelView.actor.visible
            ? this._maxPanelWidth
            : Math.min(22, this._maxPanelWidth);
        const labelWidth = Math.max(1,
            this._maxPanelWidth - reservedForIcon);
        this._panelBox.natural_width = preferredWidth;
        this._panelBox.set_style(`max-width: ${this._maxPanelWidth}px;`);
        this._panelLabelView.setMaxWidth(labelWidth);
    }

    _queueTitlePan(laterType = Meta.LaterType.IDLE) {
        if (this._titlePanLaterId)
            this._laters.remove(this._titlePanLaterId);
        this._titlePanLaterId = 0;
        if (!this.actor.menu.isOpen)
            return;
        this._titlePanLaterId = this._laters.add(laterType, () => {
            this._titlePanLaterId = 0;
            this._startTitlePan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startTitlePan() {
        const animate = this._animationsEnabled();
        this._titleLabel.clutter_text.set_ellipsize(animate
            ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END);
        if (!animate || !this.actor.menu.isOpen || !this._titleViewport.mapped) {
            this._cancelTitlePan();
            return;
        }
        const naturalWidth = measureLabelText(this._titleLabel);
        const overflow = Math.ceil(naturalWidth - this._titleViewportWidth);
        if (!(this._titleViewportWidth > 0) || overflow <= 0) {
            this._cancelTitlePan();
            return;
        }
        const period = naturalWidth + TITLE_LOOP_GAP;
        const restart = period !== this._titlePanPeriod;
        if (restart) {
            this._titleLabel.remove_all_transitions();
            this._titleLabel.translation_x = 0;
        }
        const widthChanged = this._titleViewport.layout_manager.setPanWidth(naturalWidth);
        const repeatChanged = this._titleViewport.layout_manager.setRepeatOffset(period);
        if (widthChanged || repeatChanged) {
            if (++this._titlePanRetries <= MAX_LAYOUT_WAIT_RETRIES) {
                this._queueTitlePan(Meta.LaterType.BEFORE_REDRAW);
                return;
            }
            this._cancelTitlePan();
            this._titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            return;
        }
        this._titleCopy.show();
        // Visibility and ellipsizing changes invalidate layout even when the
        // desired width is unchanged. Actor.width can report a preferred size.
        if (!this._titleViewport.has_allocation() ||
            !this._titleLabel.has_allocation() || !this._titleCopy.has_allocation() ||
            this._titleLabel.get_allocation_box().get_width() < naturalWidth - 0.5 ||
            this._titleCopy.get_allocation_box().get_width() < naturalWidth - 0.5) {
            if (++this._titlePanRetries <= MAX_LAYOUT_WAIT_RETRIES) {
                this._queueTitlePan(Meta.LaterType.BEFORE_REDRAW);
                return;
            }
            this._cancelTitlePan();
            this._titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            return;
        }
        this._titlePanRetries = 0;
        this._titlePanPeriod = period;
        if (!this._titleLabel.get_transition('translation-x'))
            this._continueTitlePan(restart ? 1000 : 0);
    }

    _continueTitlePan(delayMs = 0) {
        if (!this._titleCopy.visible || !this.actor.menu.isOpen ||
            !this._titleViewport.mapped || this._titleViewport.hover ||
            !this._animationsEnabled())
            return;
        loopTitle(this._titleLabel, this._titlePanPeriod,
            delayMs, () => this._continueTitlePan());
    }

    _cancelTitlePan() {
        this._titlePanRetries = 0;
        if (this._titlePanLaterId) {
            this._laters.remove(this._titlePanLaterId);
            this._titlePanLaterId = 0;
        }
        this._titleLabel?.remove_all_transitions();
        this._titleCopy?.hide();
        this._titleViewport?.layout_manager.setPanWidth(0);
        this._titleViewport?.layout_manager.setRepeatOffset(0);
        this._titlePanPeriod = 0;
        if (this._titleLabel)
            this._titleLabel.translation_x = 0;
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
        if (!this.actor?.menu?.isOpen ||
            !this._lyricRows[this._activeLyricIndex])
            return;

        this._scrollView.vadjustment.remove_transition('value');
        this._scrollRequest = {
            force: Boolean(this._scrollRequest?.force || force),
            immediate: Boolean(this._scrollRequest?.immediate || immediate),
        };
        this._scrollRetries = 0;
        if (this._scrollStageSignalId)
            return;

        // Wait until the stage update completes relayout so row bounds and
        // vadjustment.page_size always come from the same layout pass.
        this._scrollStageSignalId = global.stage.connect(
            'after-update',
            () => {
                const row = this.actor?.menu?.isOpen
                    ? this._lyricRows[this._activeLyricIndex]
                    : null;
                const ready = Boolean(row) && this._isScrollLayoutReady(row);
                if (row && !ready &&
                    ++this._scrollRetries <= MAX_LAYOUT_WAIT_RETRIES) {
                    this._scrollView?.queue_redraw();
                    return;
                }

                const request = this._scrollRequest;
                if (this._scrollStageSignalId) {
                    global.stage.disconnect(this._scrollStageSignalId);
                    this._scrollStageSignalId = 0;
                }
                this._scrollRequest = null;
                this._scrollRetries = 0;
                if (ready)
                    this._scrollToActive(request);
            });
        this._scrollView.queue_redraw();
    }

    _isScrollLayoutReady(row) {
        return Boolean(
            this._scrollView?.mapped &&
            row?.mapped &&
            this.actor?.menu?.actor?.has_allocation() &&
            this.actor?.menu?.box?.has_allocation() &&
            this._menuScrollView?.has_allocation() &&
            this._scrollView.has_allocation() &&
            this._lyricsBox?.has_allocation() &&
            row.has_allocation() &&
            this._scrollView.vadjustment.page_size > 0);
    }

    _cancelScheduledScroll() {
        if (this._scrollStageSignalId) {
            global.stage.disconnect(this._scrollStageSignalId);
            this._scrollStageSignalId = 0;
        }
        this._scrollRequest = null;
        this._scrollRetries = 0;
        this._scrollView?.vadjustment?.remove_transition('value');
    }

    _scrollToActive({force = false, immediate = false} = {}) {
        if (!this.actor?.menu?.isOpen)
            return;

        const row = this._lyricRows[this._activeLyricIndex];
        if (!row)
            return;

        const bounds = this._rowVerticalBounds(row);
        if (!bounds)
            return;

        const adjustment = this._scrollView.vadjustment;
        const [value, lower, upper, , , pageSize] = adjustment.get_values();
        if (pageSize <= 0)
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
        if (this._menuFocusSignalId)
            global.stage.disconnect(this._menuFocusSignalId);
        this._menuFocusSignalId = 0;
        this._cancelTitlePan();
        for (const id of this._titleAnimationSignalIds)
            this._titleAnimationSettings.disconnect(id);
        this._titleAnimationSignalIds = [];
        this._titleAnimationSettings = null;
        this._cancelScheduledScroll();
        this._cancelLayoutAnchor();
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
        this._panelLabelView?.destroy();
        this._panelLabelView = null;
        this._artworkView?.destroy();
        this._artworkView = null;
        this._progressView?.destroy();
        this._progressView = null;
        this.actor?.destroy();
        this.actor = null;
        this._menuScrollView = null;
        this._panelBox = null;
        this._icon = null;
        this._titleLabel = null;
        this._titleViewport = null;
        this._titleCopy = null;
        this._artistLabel = null;
        this._albumLabel = null;
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
