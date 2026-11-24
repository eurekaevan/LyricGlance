import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

import {ArtworkView} from '../artwork-view.js';
import {sourceLyricsHash} from '../translation-document.js';
import {getLineVisualLevel, panelTimelinesEqual} from '../ui-utils.js';

const UUID = 'lyric-glance@eureka';
const EFFECTIVE_LOCALE = GLib.getenv('LC_ALL') ??
    GLib.getenv('LANGUAGE') ?? GLib.getenv('LANG') ?? '';
const SIMPLIFIED_CHINESE = EFFECTIVE_LOCALE.startsWith('zh_CN');
const TRADITIONAL_CHINESE = EFFECTIVE_LOCALE.startsWith('zh_TW');
const uiText = (english, chinese, traditional = chinese) =>
    TRADITIONAL_CHINESE ? traditional : SIMPLIFIED_CHINESE ? chinese : english;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function referenceTextBounds(label) {
    const native = label.clutter_text.get_layout();
    const layout = Pango.Layout.new(native.get_context());
    layout.set_font_description(native.get_font_description());
    layout.set_attributes(native.get_attributes());
    layout.set_single_paragraph_mode(true);
    layout.set_text(label.text, -1);
    const [ink, logical] = layout.get_extents();
    const units = Pango.SCALE * label.clutter_text.get_resource_scale();
    const left = Math.min(ink.x, logical.x) / units;
    const right = Math.max(ink.x + ink.width, logical.x + logical.width) / units;
    return {left, right, width: right - left};
}

function referenceLabelWidth(label) {
    const bounds = referenceTextBounds(label);
    const scale = label.clutter_text.get_resource_scale();
    const node = label.get_theme_node();
    return (Math.ceil(bounds.right * scale) - Math.floor(bounds.left * scale)) / scale +
        node.get_horizontal_padding() + node.get_border_width(St.Side.LEFT) +
        node.get_border_width(St.Side.RIGHT);
}

function assertTextAllocation(label) {
    const text = label.clutter_text;
    const [ink, logical] = text.get_layout().get_extents();
    const units = Pango.SCALE * text.get_resource_scale();
    const origin = text.get_allocation_box().x1;
    const left = Math.min(ink.x, logical.x) / units + origin;
    const right = Math.max(ink.x + ink.width, logical.x + logical.width) / units +
        origin;
    const box = label.get_allocation_box();
    box.set_origin(0, 0);
    const content = label.get_theme_node().get_content_box(box);
    assert(left >= content.x1 - 0.01 && right <= content.x2 + 0.01,
        `complete shaped text must fit its drawing allocation (${left}, ${right}, ` +
            `${content.x1}..${content.x2})`);
}

// Also called by the isolated virtual-monitor harness at different scales.
export async function checkTextGeometry(view) {
    const panelStyle = view._panelLabelView._panLabel.get_style();
    const titleStyle = view._titleLabel.get_style();
    const metadata = {title: view._titleLabel.text, artist: view._artistLabel.text,
        album: view._albumLabel.text};
    const wasOpen = view.actor.menu.isOpen;
    const text = 'jf 中文 e\u0301 👩‍🚀 complete glyph bounds '.repeat(4);
    const baselineStyle = 'font-size: 20px; padding: 0; border-width: 0;';
    const waitForGeometry = async name => {
        const deadlineUs = GLib.get_monotonic_time() + 2_000_000;
        const ready = () => !view._panelLabelView._panLaterId && !view._panelLabelView._geometryLaterId &&
            !view._titlePanLaterId && view._panelLabelView.actor.mapped && view._titleViewport.mapped &&
            view._panelLabelView.actor.has_allocation() && view._titleViewport.has_allocation() &&
            [view._panelLabelView._label, view._panelLabelView._panLabel, view._panelLabelView._titleCopy,
                view._titleLabel, view._titleCopy].every(label =>
                !label.visible || label.has_allocation());
        do {
            await Scripting.sleep(20);
        } while (!ready() && GLib.get_monotonic_time() < deadlineUs);
        assert(ready(), `${name}: text layout did not settle before its deadline ` +
            `(panelLater=${view._panelLabelView._panLaterId}, geometryLater=${view._panelLabelView._geometryLaterId}, ` +
            `titleLater=${view._titlePanLaterId}, titleMapped=${view._titleViewport.mapped}, ` +
            `titlePeriod=${view._titlePanPeriod})`);
    };
    view.setVisible(true);
    view.setProgress(0, 60_000_000, {playing: false});
    view.actor.menu.open();
    try {
        for (const [name, style, insets, sample = text] of [
            ['plain', '', 0], ['fixed', 'width: 80px;', 0],
            ['minimum', 'min-width: 1800px;', 0],
            ['padding', 'width: 80px; padding: 0 20px; border: 2px solid red;', 44],
            ['italic', 'font-family: serif; font-style: italic;', 0],
            ['rtl', '', 0, 'مرحبا بالعالم هذه أغنية طويلة '.repeat(6)],
        ]) {
            view._panelLabelView._panLabel.set_style(baselineStyle + style);
            view._titleLabel.set_style(baselineStyle + style);
            view.setText(sample, {loop: true});
            view.updateMetadataDisplay({...metadata, title: sample});
            await waitForGeometry(name);
            for (const [label, copy, measured] of [
                [view._panelLabelView._panLabel, view._panelLabelView._titleCopy, view._panelLabelView._naturalWidth],
                [view._titleLabel, view._titleCopy, view._titlePanPeriod - 32],
            ]) {
                const expected = referenceTextBounds(label).width + insets;
                const rounding = 2 / label.clutter_text.get_resource_scale();
                assert(measured >= expected - 0.01 && measured <= expected + rounding,
                    `${name}: measured text must match a fresh unconstrained Pango layout ` +
                        `(${measured} versus ${expected})`);
                assert(copy.visible && label.get_allocation_box().get_width() >= measured &&
                    Math.abs(copy.get_allocation_box().x1 - measured - 32) < 0.01,
                `${name}: both copies must receive full text allocations and matching spacing ` +
                    `(${label.get_style_class_name()}, visible=${copy.visible}, ` +
                    `allocated=${label.get_allocation_box().get_width()}, measured=${measured}, ` +
                    `repeat=${copy.get_allocation_box().x1})`);
                assertTextAllocation(label);
                assertTextAllocation(copy);
            }
            print(`textGeometry=${name},scale:${view._panelLabelView._panLabel.clutter_text.get_resource_scale()},` +
                `preferred:${view._panelLabelView._panLabel.get_preferred_width(-1)[1]},` +
                `measured:${view._panelLabelView._naturalWidth},viewport:${view._panelLabelView._viewportWidth}`);
        }
        // A CSS minimum must not invent overflow for a genuinely short string.
        view._panelLabelView._panLabel.set_style(baselineStyle + 'min-width: 1800px;');
        view._titleLabel.set_style(baselineStyle + 'min-width: 1800px;');
        view.setText('Short', {loop: true});
        view.updateMetadataDisplay({...metadata, title: 'Short'});
        await waitForGeometry('fitting text');
        assert(view._panelLabelView._label.visible && !view._panelLabelView._titleCopy.visible &&
            !view._titleCopy.visible && view._titlePanPeriod === 0,
        'a minimum actor width must not make fitting text scroll');
    } finally {
        view._panelLabelView._panLabel.set_style(panelStyle);
        view._titleLabel.set_style(titleStyle);
        view.updateMetadataDisplay(metadata);
        view.setText('', {loop: false});
        if (!wasOpen)
            view.actor.menu.close();
        await Scripting.sleep(150);
    }
}

async function checkTitleWrap(label, copy, period, resume) {
    assert(copy.visible && copy.text === label.text &&
        Math.abs(copy.get_allocation_box().x1 - period) < 0.5,
    'the matching title copy must be allocated one full title plus a gap after the first');
    label.remove_all_transitions();
    label.translation_x = -(period - 4);
    assert(copy.translation_x === label.translation_x,
        'both title copies must move together');
    let wraps = 0;
    let previousX = label.translation_x;
    const signal = label.connect('notify::translation-x', () => {
        const x = label.translation_x;
        if (x > previousX + period / 2) {
            assert(Math.abs(previousX + period) < 0.5 && Math.abs(x) < 0.5,
                'a loop may reset only when the second copy exactly replaces the first');
            wraps++;
        }
        previousX = x;
    });
    try {
        resume();
        await Scripting.sleep(350);
        assert(wraps === 1 && label.translation_x < 0 && label.translation_x > -20,
            'a title must wrap seamlessly and immediately continue left');
        const x = label.translation_x;
        await Scripting.sleep(120);
        assert(label.translation_x < x && copy.translation_x === label.translation_x,
            'the next title cycle must keep moving left at the same offset');
    } finally {
        label.disconnect(signal);
    }
}

async function takeScreenshot(path) {
    const file = Gio.File.new_for_path(path);
    const stream = await new Promise((resolve, reject) => {
        file.replace_async(
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                try {
                    resolve(source.replace_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
    const screenshot = new Shell.Screenshot();
    try {
        await new Promise((resolve, reject) => {
            screenshot.screenshot(false, stream, (source, result) => {
                try {
                    source.screenshot_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    } finally {
        await new Promise(resolve => {
            stream.close_async(GLib.PRIORITY_DEFAULT, null, () => resolve());
        });
    }
}

export async function run() {
    await Scripting.sleep(1000);
    const indicatorDeadlineUs = GLib.get_monotonic_time() + 10_000_000;
    while (!Main.panel.statusArea[UUID] &&
        GLib.get_monotonic_time() < indicatorDeadlineUs)
        await Scripting.sleep(100);

    const screenshotStyle = GLib.getenv('LYRIC_GLANCE_SCREENSHOT_STYLE');
    if (['prefer-light', 'prefer-dark'].includes(screenshotStyle)) {
        const appearanceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        appearanceSettings.set_string('color-scheme', screenshotStyle);
        await Scripting.sleep(300);
    }

    const extension = Main.extensionManager.lookup(UUID);
    assert(extension, 'the extension was not discovered');
    assert(extension.metadata.url ===
        'https://github.com/eurekaevan/LyricGlance' &&
        extension.metadata['gettext-domain'] === UUID &&
        !Object.hasOwn(extension.metadata, 'version'),
    'the packaged metadata should expose URL/gettext and omit deprecated version');

    const indicator = Main.panel.statusArea[UUID];
    assert(indicator, 'the extension did not create its panel indicator');
    assert(!indicator.visible,
        'the indicator should be hidden without an MPRIS player');
    assert(indicator.reactive,
        'the indicator should be clickable');

    const instance = extension.stateObj;
    const view = instance._indicator;
    assert(view?.actor === indicator,
        'the extension should own the registered panel indicator');
    const settings = instance._settings;
    assert(view._decreaseButton.label === uiText('−0.5 s', '−0.5 秒') &&
        view._increaseButton.label === uiText('+0.5 s', '+0.5 秒') &&
        view._offsetLabel.text === uiText('+0.0 s', '+0.0 秒'),
    'offset buttons and the current offset must use the same translated unit');
    assert(settings.get_boolean('show-icon') &&
        settings.get_string('panel-position') === 'center' &&
        settings.get_int('max-panel-width') === 500 &&
        !settings.get_boolean('hide-when-paused') &&
        settings.get_boolean('fallback-track-info') &&
        settings.get_boolean('word-sync-enabled') &&
        !settings.get_boolean('translation-enabled') &&
        settings.get_boolean('auto-translate') &&
        settings.get_string('translation-target-language') === 'zh-CN' &&
        settings.get_string('translation-provider') === 'openai' &&
        settings.get_string('translation-api-endpoint') ===
            'https://api.openai.com/v1/responses' &&
        settings.get_string('translation-model') ===
            'gpt-5.4-mini-2026-03-17' &&
        settings.get_string('translation-display-mode') === 'bilingual' &&
        settings.get_string('panel-lyrics-language') === 'original' &&
        settings.get_int('global-offset-ms') === 0 &&
        settings.get_string('preferred-player') === 'auto',
    'the packaged GSettings schema should expose the Phase 5 defaults');
    assert(view._panelBox.natural_width === 500 &&
        view._panelBox.natural_width_set &&
        view._panelBox.get_style().trim() === 'max-width: 500px;' &&
        view._panelLabelView.actor.get_style().includes('478px') &&
        view._panelLabelView.actor.clip_to_allocation && view._icon.visible &&
        Main.panel._centerBox.contains(indicator.container),
        'the default preferred and maximum panel widths should apply immediately');

    const assertPanelPosition = (value, panelBox, expectedIndex) => {
        settings.set_string('panel-position', value);
        assert(indicator.container.get_parent() === panelBox &&
            panelBox.get_child_at_index(expectedIndex(panelBox)) ===
                indicator.container,
        `panel-position ${value} should move the existing indicator container`);
    };
    assertPanelPosition('far-left', Main.panel._leftBox, () => 0);
    assertPanelPosition('left', Main.panel._leftBox,
        box => box.get_n_children() - 1);
    assertPanelPosition('right', Main.panel._rightBox, () => 0);
    assertPanelPosition('far-right', Main.panel._rightBox,
        box => box.get_n_children() - 1);
    assertPanelPosition('center', Main.panel._centerBox, () => 0);

    const initialLyricsProvider = instance._lyricsProvider;
    settings.set_boolean('lrcapi-enabled', true);
    const enabledLyricsProvider = instance._lyricsProvider;
    assert(enabledLyricsProvider !== initialLyricsProvider &&
        initialLyricsProvider._session === null &&
        enabledLyricsProvider._lrcApiUrl === 'https://api.lrc.cx/jsonapi',
    'enabling fallback should replace the provider and release its old resources');
    settings.set_string('lrcapi-endpoint', 'http://127.0.0.1:28883/jsonapi');
    assert(enabledLyricsProvider._session === null &&
        instance._lyricsProvider._lrcApiUrl === 'http://127.0.0.1:28883/jsonapi',
    'runtime endpoint changes should replace the provider and apply immediately');
    settings.set_boolean('lrcapi-enabled', false);
    settings.reset('lrcapi-endpoint');
    assert(instance._lyricsProvider._lrcApiUrl === null,
        'disabling fallback should stop using its endpoint');

    const localArtwork = Gio.File.new_for_path(
        '/usr/share/pixmaps/faces/guitar2.jpg');
    view.setTrack({
        title: 'A deliberately very long title used to exercise ellipsizing',
        artist: 'Test Artist',
        album: 'Test Album',
        artUrl: localArtwork.get_uri(),
        durationUs: 220_000_000,
    }, 'shell-track-a');
    assert(view._messageLabel.text ===
        uiText('Loading lyrics…', '正在加载歌词…', '正在載入歌詞…'),
        'a track change should show the restrained loading state');
    const lines = Array.from({length: 30}, (_unused, index) => ({
        lineId: `line-${index}`,
        startMs: index * 1000,
        endMs: null,
        words: [],
        text: `Synchronized lyric line ${index + 1} with wrapping text`,
    }));
    const lineDocument = {
        source: 'lrclib-synced',
        sourceId: null,
        instrumental: false,
        metadata: {},
        syncLevel: 'line',
        lines,
    };
    for (const [source, provider] of [
        ['lrclib-synced', 'LRCLIB'], ['lrclib-plain', 'LRCLIB'],
        ['lrclib-lyricsfile', 'LRCLIB'], ['lrclib', 'LRCLIB'],
        ['lrcapi-synced', 'LrcAPI'],
    ]) {
        view.setLyrics({...lineDocument, source});
        assert(view._lyricsSourceItem.visible && view._lyricsSourceLabel.text ===
            uiText(`Lyrics source: ${provider}`, `歌词来源：${provider}`, `歌詞來源：${provider}`),
        `the source label must show the actual provider for ${source}`);
    }
    view.setLyrics(null);
    assert(!view._lyricsSourceItem.visible && !view._lyricsSourceLabel.text,
        'no lyrics must clear the previous provider label');
    view.setLyrics({...lineDocument, source: 'unknown'});
    assert(!view._lyricsSourceItem.visible, 'unknown sources must not be guessed');
    view.setLyrics(lineDocument);
    let originalRows = [...view._lyricRows];
    view.setCurrentLyricIndex(20);
    view.setText('Synchronized lyric line 21 with wrapping text');
    view.setProgress(119_000_000, 220_000_000);
    view.setVisible(true);
    await Scripting.sleep(1800);

    const panelMetrics = async text => {
        view.setText(text);
        await Scripting.sleep(180);
        const [x] = view._panelBox.get_transformed_position();
        const [iconX] = view._icon.get_transformed_position();
        return {
            width: view._panelBox.width,
            center: x + view._panelBox.width / 2,
            iconX,
        };
    };
    const shortPanel = await panelMetrics('Hello');
    const longPanel = await panelMetrics(
        'This is an extremely long synchronized lyric line that must ellipsize');
    const finalShortPanel = await panelMetrics('I know');
    print(`panelWidths=${shortPanel.width.toFixed(1)},` +
        `${longPanel.width.toFixed(1)},${finalShortPanel.width.toFixed(1)}`);
    print(`panelCenterDelta=${(longPanel.center - shortPanel.center).toFixed(1)},` +
        `iconDelta=${(longPanel.iconX - shortPanel.iconX).toFixed(1)}`);
    assert(shortPanel.width === 500 && longPanel.width === shortPanel.width &&
        Math.abs(finalShortPanel.width - shortPanel.width) < 1 &&
        Math.abs(finalShortPanel.center - shortPanel.center) < 1 &&
        Math.abs(longPanel.iconX - shortPanel.iconX) < 1,
    'short and long panel lyrics should keep a stable width, center, and icon');

    settings.set_string('panel-position', 'far-left');
    const centerConstraint = new St.Widget({
        width: Math.round(Main.layoutManager.primaryMonitor.width * 0.65),
    });
    Main.panel._centerBox.add_child(centerConstraint);
    view.setText(
        'A long lyric must yield before it reaches the centered date control');
    await Scripting.sleep(300);
    const [panelX] = view._panelBox.get_transformed_position();
    const [centerX] = Main.panel._centerBox.get_transformed_position();
    print(`constrainedLeftPanel=${view._panelBox.width.toFixed(1)},` +
        `gap=${(centerX - panelX - view._panelBox.width).toFixed(1)}`);
    assert(view._panelBox.width < shortPanel.width &&
        panelX + view._panelBox.width <= centerX + 0.5,
    'a side-positioned lyric should shrink before the centered panel area');

    settings.set_string('panel-position', 'far-right');
    await Scripting.sleep(300);
    const [rightPanelX] = view._panelBox.get_transformed_position();
    const [rightCenterX] = Main.panel._centerBox.get_transformed_position();
    const centerRight = rightCenterX + Main.panel._centerBox.width;
    print(`constrainedRightPanel=${view._panelBox.width.toFixed(1)},` +
        `gap=${(rightPanelX - centerRight).toFixed(1)}`);
    assert(view._panelBox.width < shortPanel.width &&
        rightPanelX >= centerRight - 0.5,
    'a right-positioned lyric should shrink after the centered panel area');

    centerConstraint.destroy();
    settings.set_string('panel-position', 'center');
    view.setText('Synchronized lyric line 21 with wrapping text');
    await Scripting.sleep(300);

    const panningText =
        'This synchronized lyric is deliberately long enough to pan from its beginning all the way to its ending';
    const panelTimeline = (endMs, positionMs = 0, playbackRate = 1) => ({
        startMs: 0,
        endMs,
        positionMs,
        playbackRate,
    });
    // Reproduce a slow popup mapping/layout without relying on runner speed.
    view._titleViewport.hide();
    let delayedTitleMapId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
        delayedTitleMapId = 0;
        view._titleViewport.show();
        return GLib.SOURCE_REMOVE;
    });
    try {
        await checkTextGeometry(view);
    } finally {
        if (delayedTitleMapId)
            GLib.source_remove(delayedTitleMapId);
        view._titleViewport.show();
    }
    view.setVisible(false);
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(8000),
        contentKey: 'hidden-before-song',
    });
    view.setProgress(0, 220_000_000, {playing: true, immediate: true});
    view.setVisible(true);
    await Scripting.sleep(850);
    assert(view._panelLabelView._panLabel.visible &&
        view._panelLabelView._panLabel.get_transition('translation-x'),
    'lyrics received while hidden must begin panning when the panel maps');
    view._panelLabelView._panLabel.set_style('font-size: 1px;');
    await Scripting.sleep(200);
    assert(!view._panelLabelView._panLabel.visible && view._panelLabelView._label.visible &&
        !view._panelLabelView._panLabel.get_transition('translation-x'),
    'a font change that removes overflow must cancel the stale pan');
    view._panelLabelView._panLabel.set_style(null);
    await Scripting.sleep(200);
    assert(view._panelLabelView._panLabel.visible &&
        view._panelLabelView._panLabel.get_transition('translation-x'),
    'a font change that restores overflow must restart the pan');
    const realLaters = view._panelLabelView._laters;
    const pendingPanLaters = new Set();
    view._panelLabelView.cancel();
    view._panelLabelView._laters = {
        add(type, callback) {
            const id = realLaters.add(type, () => {
                pendingPanLaters.delete(id);
                return callback();
            });
            pendingPanLaters.add(id);
            return id;
        },
        remove(id) {
            pendingPanLaters.delete(id);
            realLaters.remove(id);
        },
    };
    try {
        view._panelLabelView._queueRestart();
        view._panelLabelView._queuePan();
        assert(pendingPanLaters.size === 1,
            'queuing panel panning must replace the pending restart callback');
        view._panelLabelView._queueRestart();
        view._panelLabelView.actor.layout_manager.setPanWidth(1);
        view._panelLabelView._startPan();
        assert(pendingPanLaters.size === 1 &&
            pendingPanLaters.has(view._panelLabelView._panLaterId),
        'a pan completion or word timeout during a pending restart must retain only one Later');
        view._panelLabelView.cancel();
        assert(pendingPanLaters.size === 0 && view._panelLabelView._panLaterId === 0,
            'canceling panel panning must remove every pending Later');
    } finally {
        for (const id of pendingPanLaters)
            realLaters.remove(id);
        view._panelLabelView._panLaterId = 0;
        view._panelLabelView._laters = realLaters;
    }
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(5000),
    });
    assert(view._panelLabelView._label.clutter_text.get_ellipsize() === Pango.EllipsizeMode.NONE &&
        view._panelLabelView._label.visible,
    'synchronized lyrics should begin as full clipped text without an ellipsis');
    view.setProgress(119_000_000, 220_000_000, {
        playing: true,
        immediate: true,
    });
    await Scripting.sleep(950);
    const firstPanX = view._panelLabelView._panLabel.translation_x;
    const panNaturalWidth = referenceLabelWidth(view._panelLabelView._panLabel);
    print(`panelPanWidths=natural:${panNaturalWidth.toFixed(1)},` +
        `actor:${view._panelLabelView._panLabel.width.toFixed(1)},` +
        `viewport:${view._panelLabelView.actor.width.toFixed(1)}`);
    assert(view._panelLabelView._panLabel.visible && !view._panelLabelView._label.visible &&
        firstPanX < 0 &&
        Math.abs(view._panelLabelView._panLabel.width - panNaturalWidth) < 0.5 &&
        view._panelLabelView._panLabel.width > view._panelLabelView.actor.width &&
        view._panelLabelView._panLabel.get_transition('translation-x'),
    'an overflowing synchronized lyric should pan at full width inside its clipped viewport');
    assert(view._panelLabelView._fadeEffect.enabled &&
        view._panelLabelView.actor.clip_to_allocation &&
        Math.abs(view._panelLabelView._label.width - panNaturalWidth) < 0.5 &&
        view._panelLabelView._fadeEffect._edges[1] > 0 &&
        view._panelLabelView._fadeEffect._edges[2] === 1,
    'clipped synchronized lyrics should fade their overflowing edges during motion');
    view._panelLabelView.pause();
    await Scripting.sleep(180);
    const pausedPanX = view._panelLabelView._panLabel.translation_x;
    assert(Math.abs(pausedPanX - firstPanX) < 0.5,
        'hover-style pause should freeze the panel lyric pan in place');
    view._panelLabelView.resume();
    assert(view._panelLabelView._panLabel.visible && !view._panelLabelView._label.visible &&
        Math.abs(view._panelLabelView._panLabel.translation_x - pausedPanX) < 0.5,
    'leaving hover should start catching up without resetting or jumping');
    await Scripting.sleep(100);
    assert(view._panelLabelView._panLabel.translation_x < pausedPanX,
        'leaving hover should smoothly catch up to lyric time');
    view._panelLabelView.pause();
    const interruptedCatchUpX = view._panelLabelView._panLabel.translation_x;
    await Scripting.sleep(180);
    assert(Math.abs(view._panelLabelView._panLabel.translation_x - interruptedCatchUpX) < 0.5 &&
        !view._panelLabelView._panLabel.get_transition('translation-x'),
    'hovering again should cancel catch-up without restarting linear motion');
    view._panelLabelView.resume();
    await Scripting.sleep(280);
    const catchUpOverflow = Math.ceil(
        panNaturalWidth - view._panelLabelView.actor.width) + 8;
    const expectedCatchUpX = -catchUpOverflow *
        ((view._panelLabelView._positionAt() - 600) / 3400);
    assert(Math.abs(view._panelLabelView._panLabel.translation_x - expectedCatchUpX) < 8 &&
        view._panelLabelView._panLabel.get_transition('translation-x'),
    'catch-up should reconnect to the moving timeline and continue linearly');
    const beforeResyncX = view._panelLabelView._panLabel.translation_x;
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(5000, view._panelLabelView._positionAt()),
    });
    assert(view._panelLabelView._panLabel.visible && !view._panelLabelView._label.visible &&
        Math.abs(view._panelLabelView._panLabel.translation_x - beforeResyncX) < 0.5,
    'resynchronizing the same line must keep the currently visible text and offset');
    settings.set_int('max-panel-width', 150);
    await Scripting.sleep(300);
    assert(view._panelLabelView._panLabel.visible &&
        view._panelLabelView._panLabel.width > view._panelLabelView.actor.width &&
        view._panelLabelView._panLabel.get_transition('translation-x'),
    'resizing an active overflow should reallocate before resuming its pan');
    settings.set_int('max-panel-width', 500);
    await Scripting.sleep(300);
    assert(view._panelLabelView._panLabel.visible &&
        view._panelLabelView._panLabel.width > view._panelLabelView.actor.width,
    'restoring the panel width should keep the active pan allocated');
    const panelAllocationStarts = [];
    const panelEase = view._panelLabelView._panLabel.ease;
    view._panelLabelView._panLabel.ease = function (params) {
        panelAllocationStarts.push({allocated: this.has_allocation(),
            viewportAllocated: view._panelLabelView.actor.has_allocation(),
            width: this.get_allocation_box().get_width(),
            natural: referenceLabelWidth(this)});
        return panelEase.call(this, params);
    };
    try {
        view.setText('Short', {scrollable: true,
            timeline: panelTimeline(5000), contentKey: 'allocation-short'});
        await Scripting.sleep(100);
        assert(!view._panelLabelView._panLabel.visible,
            'the fitting middle lyric must remove the moving label from layout');
        view.setText(panningText, {scrollable: true,
            timeline: panelTimeline(5000, 1000), contentKey: 'allocation-repeat'});
        await Scripting.sleep(180);
        assert(panelAllocationStarts.length > 0 && panelAllocationStarts.every(start =>
            start.allocated && start.viewportAllocated && start.width >= start.natural - 0.5),
        'a repeated same-width lyric must be fully allocated before starting a transition: ' +
            JSON.stringify(panelAllocationStarts));
    } finally {
        view._panelLabelView._panLabel.ease = panelEase;
    }
    const hoverPopupWasOpen = indicator.menu.isOpen;
    const hoverLabelStyle = view._panelLabelView._panLabel.get_style();
    indicator.menu.close();
    try {
        view.setProgress(0, 220_000_000, {playing: false});
        view.setText(panningText, {scrollable: true,
            timeline: panelTimeline(8000, 2000), contentKey: 'hover-refresh'});
        await Scripting.sleep(120);
        view.setProgress(0, 220_000_000, {playing: true});
        await Scripting.sleep(80);
        view._panelLabelView._hovered = true;
        view._panelLabelView.pause();
        const heldX = view._panelLabelView._panLabel.translation_x;
        for (const positionMs of [4000, 7900]) {
            view.setText(panningText, {scrollable: true,
                timeline: panelTimeline(8000, positionMs), contentKey: 'hover-refresh'});
            await Scripting.sleep(100);
            assert(Math.abs(view._panelLabelView._panLabel.translation_x - heldX) < 0.5 &&
                view._panelLabelView._paused && view._panelLabelView._wordTimeoutId === 0 &&
                !view._panelLabelView._panLabel.get_transition('translation-x'),
            'same-content background refreshes must preserve hover position, including the ending hold');
        }
        view.setText(panningText, {scrollable: true,
            timeline: panelTimeline(8000, 7800), contentKey: 'hover-refresh'});
        view._panelLabelView._hovered = false;
        view._panelLabelView.resume();
        assert(Math.abs(view._panelLabelView._panLabel.translation_x - heldX) < 0.5,
            'leaving hover during a queued refresh must not jump immediately');
        await Scripting.sleep(320);
        assert(view._panelLabelView._panLabel.translation_x < heldX && !view._panelLabelView._paused,
            'leaving hover must catch up to the newest ending even without a next boundary');

        view._panelLabelView._hovered = true;
        view._panelLabelView.pause();
        const heldEndX = view._panelLabelView._panLabel.translation_x;
        view.setText(panningText, {scrollable: true,
            timeline: panelTimeline(8000, 1000), contentKey: 'hover-refresh'});
        view._panelLabelView._panLabel.set_style('font-size: 10px;');
        await Scripting.sleep(180);
        const resizedMinimumX = -(Math.ceil(view._panelLabelView._naturalWidth - view._panelLabelView._viewportWidth) + 8);
        const clampedX = Math.max(resizedMinimumX, heldEndX);
        assert(resizedMinimumX < 0 &&
            Math.abs(view._panelLabelView._panLabel.translation_x - clampedX) < 0.5 &&
            view._panelLabelView._paused,
        'hovered font changes must clamp the old offset to the new range rather than seek to lyric time');
        settings.set_int('max-panel-width', 200);
        assert(view._panelLabelView._panLabel.visible &&
            Math.abs(view._panelLabelView._panLabel.translation_x - clampedX) < 0.5,
        'a hovered width change must retain the visible reading position before layout');
        await Scripting.sleep(180);
        assert(Math.abs(view._panelLabelView._panLabel.translation_x - clampedX) < 0.5 &&
            view._panelLabelView._paused && !view._panelLabelView._panLabel.get_transition('translation-x'),
        'hovered viewport reallocation must not restart motion');
        settings.set_int('max-panel-width', 500);
        await Scripting.sleep(180);
        view.setText(panningText, {scrollable: true,
            timeline: panelTimeline(8000, 0), contentKey: 'hover-next-line'});
        await Scripting.sleep(120);
        assert(Math.abs(view._panelLabelView._panLabel.translation_x -
            view._panelLabelView._panState(view._panelLabelView._positionAt()).initialX) < 0.5 &&
            view._panelLabelView._paused,
        'a new content key must initialize its own position while remaining hover-paused');
        view._panelLabelView._panLabel.set_style('font-size: 1px;');
        await Scripting.sleep(120);
        assert(view._panelLabelView._label.visible && !view._panelLabelView._panLabel.visible && !view._panelLabelView._paused,
            'removing overflow must release the paused pan and show the fitted label');
    } finally {
        view._panelLabelView._hovered = false;
        view._panelLabelView._panLabel.set_style(hoverLabelStyle);
        settings.set_int('max-panel-width', 500);
        if (hoverPopupWasOpen)
            indicator.menu.open();
    }
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(8000),
        contentKey: 'external-width',
    });
    settings.set_string('panel-position', 'left');
    const panConstraint = new St.Widget({width: 200, height: 1});
    Main.panel._centerBox.add_child(panConstraint);
    await Scripting.sleep(700);
    const panViewportWidths = [];
    for (let index = 0; index < 8; index++) {
        panConstraint.width = index % 2 ? 200 : 750;
        await Scripting.sleep(150);
        panViewportWidths.push(view._panelLabelView.actor.width);
        assert(view._panelLabelView._panLabel.visible &&
            view._panelLabelView._panLabel.get_transition('translation-x'),
        'external panel constraints should reallocate and restart an active pan');
        const actualWidth = view._panelLabelView.actor.width;
        const actualOverflow = Math.ceil(
            referenceLabelWidth(view._panelLabelView._panLabel) - actualWidth);
        assert(view._panelLabelView._targetX === -(actualOverflow + 8),
            'external compression must set the endpoint from allocated text width');
        print(`externalPanelWidth=setting:${settings.get_int('max-panel-width')},` +
            `box:${view._panelBox.width},text:${actualWidth},target:${view._panelLabelView._targetX}`);
        if (index === 0) {
            settings.set_int('max-panel-width', 640);
            await Scripting.sleep(150);
            assert(view._panelLabelView.actor.width === actualWidth &&
                view._panelLabelView._panLabel.visible &&
                view._panelLabelView._panLabel.get_transition('translation-x'),
            'changing a width preference without changing the constrained allocation must resume panning');
            settings.set_int('max-panel-width', 500);
            await Scripting.sleep(150);
            view.setShowIcon(view._showIcon);
            await Scripting.sleep(150);
            assert(view._panelLabelView.actor.width === actualWidth &&
                view._panelLabelView._panLabel.visible &&
                view._panelLabelView._panLabel.get_transition('translation-x'),
            'reapplying the icon preference must not stop a constrained pan');
        }
    }
    assert(Math.max(...panViewportWidths) - Math.min(...panViewportWidths) > 100,
        'the allocation regression should exercise substantial viewport changes');
    panConstraint.width = 750;
    view.setText(panningText, {scrollable: true,
        timeline: panelTimeline(8000, 8000), contentKey: 'compressed-ending'});
    await Scripting.sleep(200);
    const [compressedTextX] = view._panelLabelView._panLabel.get_transformed_position();
    const [compressedViewportX] = view._panelLabelView.actor.get_transformed_position();
    assert(Math.abs(compressedTextX + view._panelLabelView._panLabel.width -
        compressedViewportX - view._panelLabelView.actor.width + 8) <= 1.5,
    'the final glyph must reach the actual viewport ending under external compression');
    view.setProgress(0, 8000000, {playing: false});
    panConstraint.width = 200;
    view.setText('A lyric that fits before compression', {scrollable: true,
        timeline: panelTimeline(8000, 8000), contentKey: 'compression-fit-boundary'});
    await Scripting.sleep(150);
    const fitNaturalWidth = referenceLabelWidth(view._panelLabelView._panLabel);
    assert(fitNaturalWidth < view._panelLabelView.actor.width &&
        !view._panelLabelView._panLabel.visible && !view._panelLabelView._fadeEffect.enabled,
    'a lyric that fits its allocated viewport must remain static');
    panConstraint.width = 750;
    await Scripting.sleep(150);
    print(`compressedFit=natural:${fitNaturalWidth},` +
        `viewport:${view._panelLabelView.actor.width},offset:${view._panelLabelView._panLabel.translation_x}`);
    assert(fitNaturalWidth > view._panelLabelView.actor.width &&
        view._panelLabelView._panLabel.visible &&
        Math.abs(fitNaturalWidth + view._panelLabelView._panLabel.translation_x -
            view._panelLabelView.actor.width + 8) <= 1.5,
    'external compression must reveal the ending even when the lyric originally fitted');
    panConstraint.width = 200;
    await Scripting.sleep(150);
    assert(!view._panelLabelView._panLabel.visible && view._panelLabelView._label.visible &&
        view._panelLabelView._wordTimeoutId === 0 && !view._panelLabelView._fadeEffect.enabled,
    'releasing external space must restore a static fitting lyric and clear scrolling state');
    view.setProgress(0, 8000000, {playing: true});
    panConstraint.destroy();
    settings.set_string('panel-position', 'center');
    await Scripting.sleep(150);
    view._panelLabelView.pause();
    view._panelLabelView.resume();
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(5000),
        contentKey: 'repeated-line-2',
    });
    assert(view._panelLabelView._panLabel.translation_x === 0 &&
        !view._panelLabelView._panLabel.visible && view._panelLabelView._label.visible,
    'a repeated lyric with a new line ID should still reset the old panel pan');
    await Scripting.sleep(280);
    assert(Math.abs(view._panelLabelView._panLabel.translation_x) < 0.5,
        'a new line should cancel catch-up and preserve its initial hold');
    view.setText('The next line', {
        scrollable: true,
        timeline: panelTimeline(3000),
    });
    assert(view._panelLabelView._panLabel.translation_x === 0 &&
        !view._panelLabelView._panLabel.visible && view._panelLabelView._label.visible,
    'a line change should cancel the old panel pan and reset to the new start');
    view.setText(panningText, {scrollable: false});
    await Scripting.sleep(120);
    assert(!view._panelLabelView._panLabel.visible && view._panelLabelView._label.visible,
        'fallback track information should remain ellipsized without panning');
    assert(view._panelLabelView._label.clutter_text.get_ellipsize() === Pango.EllipsizeMode.END &&
        !view._panelLabelView._fadeEffect.enabled,
    'fallback text should retain its ellipsis without the lyric edge effect');
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(1800),
        contentKey: 'full-ending',
    });
    await Scripting.sleep(1900);
    const [panEndX] = view._panelLabelView._panLabel.get_transformed_position();
    const [viewportEndX] = view._panelLabelView.actor.get_transformed_position();
    const panRight = panEndX + view._panelLabelView._panLabel.width;
    const viewportRight = viewportEndX + view._panelLabelView.actor.width;
    print(`panelPanEndDelta=${(panRight - viewportRight).toFixed(1)}`);
    assert(view._panelLabelView._panLabel.clutter_text.get_text() === panningText &&
        Math.abs(panRight - viewportRight + 8) <= 1.5,
    'the completed panel pan should reveal the full ending with eight pixels of space');
    assert(view._panelLabelView._fadeEffect._edges[2] === 0,
        'the fully revealed lyric ending should not be faded');

    // Find a real glyph string that exceeds this viewport by only a few pixels.
    let tinyText = '';
    let tinyNaturalWidth = 0;
    while (tinyNaturalWidth <= view._panelLabelView.actor.width) {
        tinyText += 'i';
        view._panelLabelView._panLabel.text = tinyText;
        tinyNaturalWidth = referenceLabelWidth(view._panelLabelView._panLabel);
    }
    const tinyOverflow = Math.ceil(tinyNaturalWidth - view._panelLabelView.actor.width);
    assert(tinyOverflow > 0 && tinyOverflow <= 8,
        'the small overflow regression should exceed the viewport by at most eight pixels');
    view.setText(tinyText, {
        scrollable: true,
        timeline: panelTimeline(1200),
        contentKey: 'tiny-overflow',
    });
    await Scripting.sleep(300);
    const tinyPanX = view._panelLabelView._panLabel.translation_x;
    assert(tinyPanX < 0 && tinyPanX > -tinyOverflow &&
        view._panelLabelView._targetX === -tinyOverflow,
    'a small overflow should move gently without adding eight pixels of travel');
    await Scripting.sleep(1050);
    assert(Math.abs(view._panelLabelView._panLabel.translation_x + tinyOverflow) < 0.5,
        'small overflow motion should reveal the full ending by the line boundary');

    view.setProgress(119_000_000, 220_000_000, {playing: false});
    view.setText(panningText, {
        scrollable: true,
        timeline: panelTimeline(5000, 3000),
        contentKey: 'seek-position',
    });
    await Scripting.sleep(100);
    const seekOverflow = Math.ceil(
        panNaturalWidth - view._panelLabelView.actor.width) + 8;
    const expectedSeekX = -seekOverflow * ((3000 - 600) / 3400);
    print(`panelPanSeekDelta=${(
        view._panelLabelView._panLabel.translation_x - expectedSeekX).toFixed(1)}`);
    assert(view._panelLabelView._panLabel.visible &&
        !view._panelLabelView._panLabel.get_transition('translation-x') &&
        Math.abs(view._panelLabelView._panLabel.translation_x - expectedSeekX) <= 1.5,
    'a paused seek should immediately anchor the panel pan to lyric time');

    view.setProgress(0, 5000000, {playing: true});
    for (const duration of [120, 240, 500, 1000]) {
        view.setText(panningText, {scrollable: true,
            timeline: panelTimeline(duration), contentKey: `ending-frame-${duration}`});
        await new Promise((resolve, reject) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
                try {
                    assert(view._panelLabelView._panLabel.visible &&
                        view._panelLabelView._panLabel.width + view._panelLabelView._panLabel.translation_x <=
                            view._panelLabelView.actor.width,
                    'a fast line must expose its ending before the next-line callback cancels it');
                    view.setText('Next lyric line');
                    resolve();
                } catch (error) {
                    reject(error);
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }
    view.setProgress(0, 5000000, {playing: false});

    // Opening the popup must release an accidental hover freeze on its button.
    const popupWasOpen = indicator.menu.isOpen;
    view._panelLabelView._hovered = true;
    view.setText(panningText, {scrollable: true,
        timeline: panelTimeline(5000), contentKey: 'popup-hover'});
    view.setProgress(0, 5000000, {playing: true});
    indicator.menu.open();
    await Scripting.sleep(850);
    assert(view._panelLabelView._panLabel.translation_x < 0 && !view._panelLabelView._paused,
        'panel lyrics should keep moving with the popup open even if its button remains hovered');
    view._panelLabelView._hovered = false;
    view.setProgress(0, 5000000, {playing: false});
    if (!popupWasOpen)
        indicator.menu.close();

    const panelWords = [
        {text: '你好 é 😀 ', startMs: 0, endMs: 1000},
        {text: 'This deliberately wide singing word ', startMs: 1500, endMs: 2500},
        {text: '停顿之后 continuing the melody ', startMs: 2500, endMs: 4000},
        {text: 'the final words of this synchronized line', startMs: 4000, endMs: 6000},
    ];
    const panelWordText = panelWords.map(word => word.text).join('');
    view.setText(panelWordText, {scrollable: true, words: panelWords,
        timeline: panelTimeline(6000, 1200), contentKey: 'panel-word-gap'});
    view.setProgress(0, 6000000, {playing: true});
    await Scripting.sleep(100);
    const gapWordX = view._panelLabelView._panLabel.translation_x;
    assert(view._panelLabelView._wordTimeoutId !== 0 &&
        view._panelLabelView._panState(view._panelLabelView._positionAt()).nextMs === 1500 &&
        !view._panelLabelView._panLabel.get_transition('translation-x'),
    'playback during a word gap should hold its position until the next word starts');
    await Scripting.sleep(450);
    assert(view._panelLabelView._wordTimeoutId !== 0 &&
        view._panelLabelView._panState(view._panelLabelView._positionAt()).nextMs === 2500 &&
        view._panelLabelView._panLabel.translation_x <= gapWordX,
    'the gap callback should advance to the next word without restarting the line');
    view.setProgress(0, 6000000, {playing: false});
    view.setText(panelWordText, {scrollable: true, words: panelWords,
        timeline: panelTimeline(6000, 2000), contentKey: 'panel-words'});
    await Scripting.sleep(100);
    const geometry = view._panelLabelView._wordGeometry?.words;
    assert(geometry?.length === panelWords.length,
        'Chinese, Latin, combining characters and emoji should use measured UTF-8 word boundaries');
    const focusX = (geometry[1].startX + geometry[1].endX) / 2;
    const wordDistance = Math.ceil(view._panelLabelView._panLabel.width - view._panelLabelView.actor.width) + 8;
    const expectedWordX = -Math.min(wordDistance,
        Math.max(0, focusX - view._panelLabelView.actor.width * 0.6));
    assert(Math.abs(view._panelLabelView._panLabel.translation_x - expectedWordX) < 1 &&
        view._panelLabelView._wordTimeoutId === 0,
    'a paused seek should immediately place the current word at the viewport focus');
    view.setProgress(0, 6000000, {playing: true});
    await Scripting.sleep(120);
    assert(view._panelLabelView._wordTimeoutId !== 0,
        'word follow should schedule a one-shot word boundary while playing');
    const wordHoverPopupWasOpen = indicator.menu.isOpen;
    indicator.menu.close();
    view._panelLabelView._hovered = true;
    view._panelLabelView.pause();
    const hoveredWordX = view._panelLabelView._panLabel.translation_x;
    await Scripting.sleep(220);
    assert(view._panelLabelView._wordTimeoutId === 0 &&
        Math.abs(view._panelLabelView._panLabel.translation_x - hoveredWordX) < 0.5,
    'hover should stop both word motion and its boundary callback');
    view.setText(panelWordText, {scrollable: true,
        words: panelWords.map(word => ({...word})),
        timeline: panelTimeline(6000, 5900), contentKey: 'panel-words'});
    await Scripting.sleep(100);
    assert(Math.abs(view._panelLabelView._panLabel.translation_x - hoveredWordX) < 0.5 &&
        view._panelLabelView._paused && view._panelLabelView._wordTimeoutId === 0,
    'new word timing must not move hovered text or lose the pause at the final word');
    view.setText(panelWordText, {scrollable: true, words: panelWords,
        timeline: panelTimeline(6000, 2400), contentKey: 'panel-words'});
    view._panelLabelView._hovered = false;
    view._panelLabelView.resume();
    assert(Math.abs(view._panelLabelView._panLabel.translation_x - hoveredWordX) < 0.5,
        'word follow should catch up from the held position without an immediate jump');
    await Scripting.sleep(280);
    assert(view._panelLabelView._wordTimeoutId !== 0 && view._panelLabelView._panLabel.translation_x < hoveredWordX,
        'word catch-up should reconnect across the next word boundary');
    if (wordHoverPopupWasOpen)
        indicator.menu.open();
    settings.set_int('max-panel-width', 200);
    await Scripting.sleep(100);
    assert(view._panelLabelView._wordTimeoutId !== 0 &&
        Math.abs(view._panelLabelView._panLabel.translation_x -
            view._panelLabelView._panState(view._panelLabelView._positionAt()).initialX) < 8,
        'a panel resize should reconnect word focus using the new viewport width');
    settings.set_int('max-panel-width', 500);
    await Scripting.sleep(100);
    view.setProgress(0, 6000000, {playing: false});
    await Scripting.sleep(80);
    const pausedWordX = view._panelLabelView._panLabel.translation_x;
    await Scripting.sleep(120);
    assert(view._panelLabelView._wordTimeoutId === 0 &&
        Math.abs(view._panelLabelView._panLabel.translation_x - pausedWordX) < 0.5,
        'playback pause should freeze word follow and cancel its boundary timer');
    view.setProgress(0, 6000000, {playing: true});
    view.setWordSyncEnabled(false);
    await Scripting.sleep(100);
    assert(view._panelLabelView._wordTimeoutId === 0,
        'disabling word sync should cancel panel word callbacks and use line motion');
    view.setWordSyncEnabled(true);
    view.setText(panelWordText, {scrollable: true,
        timeline: panelTimeline(6000, 3000), contentKey: 'panel-translation'});
    await Scripting.sleep(100);
    assert(view._panelLabelView._words === null && view._panelLabelView._wordTimeoutId === 0,
        'translated or line-only text should retain line motion without word callbacks');
    view.setText('مرحبا بالعالم '.repeat(8), {scrollable: true,
        words: [{text: 'مرحبا بالعالم '.repeat(8), startMs: 0, endMs: 6000}],
        timeline: panelTimeline(6000, 3000), contentKey: 'panel-rtl'});
    await Scripting.sleep(100);
    assert(view._panelLabelView._wordGeometry?.words === null && view._panelLabelView._wordTimeoutId === 0,
        'bidirectional geometry should fall back to line motion');
    const overlappingWords = panelWords.map((word, index) =>
        ({...word, startMs: index === 1 ? 500 : word.startMs}));
    view.setText(panelWordText, {scrollable: true, words: overlappingWords,
        timeline: panelTimeline(6000, 3000), contentKey: 'panel-overlap'});
    await Scripting.sleep(100);
    assert(view._panelLabelView._wordGeometry?.words === null && view._panelLabelView._wordTimeoutId === 0,
        'overlapping word times should fall back to line motion');
    const splitGrapheme = [
        {text: 'e', startMs: 0, endMs: 1000},
        {text: '́ long lyric text '.repeat(12), startMs: 1000, endMs: 6000},
    ];
    view.setText(splitGrapheme.map(word => word.text).join(''), {
        scrollable: true, words: splitGrapheme,
        timeline: panelTimeline(6000, 3000), contentKey: 'panel-split-grapheme'});
    await Scripting.sleep(100);
    assert(view._panelLabelView._wordGeometry?.words === null && view._panelLabelView._wordTimeoutId === 0,
        'word boundaries inside a combining grapheme should fall back to line motion');
    view.setProgress(0, 6000000, {playing: false});

    view.setProgress(119_000_000, 220_000_000, {playing: false});
    view.setText('Synchronized lyric line 21 with wrapping text');

    assert(view._titleLabel.text.startsWith('A deliberately'),
        'the popup should show the track title');
    assert(view._artistLabel.text === 'Test Artist',
        'the popup should show the artist');
    assert(view._albumLabel.text === 'Test Album' && view._albumLabel.visible,
        'the popup should show a present album');
    const titleMetadata = {title: view._titleLabel.text,
        artist: view._artistLabel.text, album: view._albumLabel.text};
    const titlePopupWasOpen = indicator.menu.isOpen;
    indicator.menu.open();
    await Scripting.sleep(300);
    let loopTitle = 'Loop title ';
    view._cancelTitlePan();
    const titleMeasure = view._titleLabel.clutter_text.get_layout().copy();
    titleMeasure.set_ellipsize(Pango.EllipsizeMode.NONE);
    titleMeasure.set_width(-1);
    do {
        loopTitle += 'i';
        titleMeasure.set_text(loopTitle, -1);
    } while (titleMeasure.get_pixel_size()[0] <=
        view._titleViewport.width + 4 && loopTitle.length < 300);
    assert(titleMeasure.get_pixel_size()[0] > view._titleViewport.width &&
        titleMeasure.get_pixel_size()[0] < view._titleViewport.width + 30,
        'the title loop regression should use a short overflow with a bounded cycle');
    view.updateMetadataDisplay({...titleMetadata, title: loopTitle + 'i'});
    await Scripting.sleep(2300);
    const titlePeriod = referenceLabelWidth(view._titleLabel) + 32;
    print(`titlePan=viewport:${view._titleViewport.width},` +
        `natural:${view._titleLabel.get_preferred_width(-1)[1]},` +
        `actor:${view._titleLabel.width},offset:${view._titleLabel.translation_x},` +
        `mapped:${view._titleViewport.mapped},open:${indicator.menu.isOpen}`);
    assert(view._titleLabel.clutter_text.get_ellipsize() === Pango.EllipsizeMode.NONE &&
        view._titleLabel.translation_x < 0 && view._titleCopy.visible,
    'an overflowing title must move left without an ellipsis');
    view._titleViewport.set_hover(true);
    const hoveredPopupX = view._titleLabel.translation_x;
    await Scripting.sleep(80);
    assert(view._titleLabel.translation_x === hoveredPopupX &&
        !view._titleLabel.get_transition('translation-x'),
    `hovering the popup title must freeze both copies (${hoveredPopupX} -> ` +
        `${view._titleLabel.translation_x}, hover=${view._titleViewport.hover})`);
    view._titleViewport.set_hover(false);
    assert(view._titleLabel.translation_x === hoveredPopupX,
        'leaving the popup title must resume without a jump');
    await checkTitleWrap(view._titleLabel, view._titleCopy, titlePeriod,
        () => view._continueTitlePan());
    const titleAllocationStarts = [];
    const titleEase = view._titleLabel.ease;
    view._titleLabel.ease = function (params) {
        titleAllocationStarts.push({allocated: this.has_allocation(),
            viewportAllocated: view._titleViewport.has_allocation(),
            width: this.get_allocation_box().get_width(),
            copyWidth: view._titleCopy.get_allocation_box().get_width(),
            natural: referenceLabelWidth(this)});
        return titleEase.call(this, params);
    };
    try {
        for (let index = 0; index < 2; index++) {
            St.Settings.get().inhibit_animations();
            await Scripting.sleep(100);
            assert(!view._titleCopy.visible &&
                view._titleLabel.clutter_text.get_ellipsize() === Pango.EllipsizeMode.END,
            'animation inhibition must return the popup title to a fitted allocation');
            St.Settings.get().uninhibit_animations();
            await Scripting.sleep(180);
        }
        if (St.ReducedMotion) {
            const motionSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
            const originalMotion = motionSettings.get_string('reduced-motion');
            try {
                motionSettings.set_string('reduced-motion', 'reduce');
                await Scripting.sleep(100);
                assert(!view._titleCopy.visible,
                    'reduced motion must hide the popup title copy before restoring it');
            } finally {
                motionSettings.set_string('reduced-motion', originalMotion);
            }
            await Scripting.sleep(180);
        }
        assert(titleAllocationStarts.length >= 2 && titleAllocationStarts.every(start =>
            start.allocated && start.viewportAllocated &&
            start.width >= start.natural - 0.5 && start.copyWidth >= start.natural - 0.5),
        'restoring title animation must allocate both copies before transitioning: ' +
            JSON.stringify(titleAllocationStarts));
    } finally {
        view._titleLabel.ease = titleEase;
    }
    indicator.menu.close();
    assert(view._titleLabel.translation_x === 0 && view._titlePanLaterId === 0 &&
        !view._titleLabel.get_transition('translation-x') && !view._titleCopy.visible,
    'closing the popup should cancel the title loop and pending allocation callback');
    indicator.menu.open();
    await Scripting.sleep(1400);
    assert(view._titleLabel.get_transition('translation-x') &&
        view._titleLabel.translation_x < 0,
        'reopening the popup should restart a mapped title loop');
    view.updateMetadataDisplay({...titleMetadata, title: 'Short'});
    await Scripting.sleep(100);
    assert(!view._titleCopy.visible && view._titleLabel.translation_x === 0 &&
        !view._titleLabel.get_transition('translation-x'),
    'a fitting replacement title must remain static and hide the old copy');
    view.updateMetadataDisplay(titleMetadata);
    if (!titlePopupWasOpen)
        indicator.menu.close();
    // The longer animation checks exceed PerfHelper's 30-second idle window.
    // A normal helper request renews it so the harness can cleanly exit later.
    await Scripting.waitTestWindows();
    assert(view._artworkView._displayedTrackKey === 'shell-track-a' &&
        view._artworkView.actor.width === 80 &&
        view._artworkView.actor.height === 80 &&
        !view._artworkView._fallback.visible,
    'the compact file:// artwork should decode and replace its matching placeholder');

    const raceLoader = {
        load(url) {
            return new Promise(resolve => {
                GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    url.endsWith('/a') ? 180 : 20,
                    () => {
                        resolve({file: localArtwork, remote: false});
                        return GLib.SOURCE_REMOVE;
                    });
            });
        },
        discard() {},
        destroy() {},
    };
    const raceArtwork = new ArtworkView({loader: raceLoader});
    Main.uiGroup.add_child(raceArtwork.actor);
    raceArtwork.setArtwork('file:///delayed/a', 'track-a');
    raceArtwork.setArtwork('file:///fast/b', 'track-b');
    await Scripting.sleep(80);
    assert(raceArtwork._displayedTrackKey === 'track-b',
        'late artwork from track A must never overwrite track B');
    const oldArtworkActor = raceArtwork._textureActor;
    raceArtwork.setArtwork('file:///delayed/a', 'track-c');
    await Scripting.sleep(60);
    assert(raceArtwork._textureActor === oldArtworkActor &&
        !raceArtwork._fallback.visible,
    'a delayed replacement should retain old artwork instead of flashing fallback');
    await Scripting.sleep(150);
    assert(raceArtwork._displayedTrackKey === 'track-c' &&
        raceArtwork._textureActor !== oldArtworkActor &&
        raceArtwork._outgoingTextureActor === oldArtworkActor,
    'decoded artwork should crossfade from the retained texture');
    await Scripting.sleep(250);
    assert(!raceArtwork._outgoingTextureActor,
        'a completed artwork crossfade should release the old texture');
    raceArtwork.destroy();

    const reducedArtwork = new ArtworkView({
        loader: raceLoader,
        animationsEnabled: () => false,
    });
    Main.uiGroup.add_child(reducedArtwork.actor);
    reducedArtwork.setArtwork('file:///fast/b', 'reduced-a');
    await Scripting.sleep(80);
    reducedArtwork.setArtwork('file:///fast/b', 'reduced-b');
    await Scripting.sleep(80);
    assert(reducedArtwork._displayedTrackKey === 'reduced-b' &&
        !reducedArtwork._outgoingTextureActor,
    'reduced motion should replace ready artwork without crossfade');
    reducedArtwork.destroy();

    assert(view._progressView._currentLabel.text === '1:59' &&
        view._progressView._durationLabel.text === '3:40' &&
        view._progressView.actor.visible,
    'the popup should format and display current playback progress');
    view.setProgress(999_000_000, 220_000_000);
    assert(view._progressView._currentLabel.text === '3:40' &&
        view._progressView._slider.value === 1,
    'progress should clamp safely at track end');
    view.setProgress(119_000_000, 220_000_000);

    view.updateMetadataDisplay({
        title: 'A second deliberately long title that must stay inside the media header',
        artist: 'An exceptionally long artist name that must ellipsize instead of widening the popup',
        album: '',
    });
    assert(view._artistLabel.clutter_text.get_single_line_mode() &&
        !view._albumLabel.visible && view._albumLabel.text === '' &&
        view._lyricRows.every((row, index) => row === originalRows[index]),
    'long or missing metadata must hide the empty album without rebuilding lyrics');
    view.updateMetadataDisplay({
        title: 'A deliberately very long title used to exercise ellipsizing',
        artist: 'Test Artist',
        album: 'Test Album',
    });
    assert(view._lyricRows.length === lines.length,
        'the popup should create one row per parsed lyric entry');
    assert(view._lyricRows[20].has_style_class_name(
        'lyric-glance-line-current') && view._lyricRows[20].opacity === 255 &&
        view._lyricRows[19].has_style_class_name('lyric-glance-line-near') &&
        view._lyricRows[18].has_style_class_name('lyric-glance-line-mid') &&
        view._lyricRows[17].has_style_class_name('lyric-glance-line-far'),
    'the current lyric should drive centralized distance-based visual levels');
    assert(!view._lyricRows[20].has_style_pseudo_class('selected'),
        'lyric focus must not depend on a card-like selected background');
    const styledRows = new Set();
    const removeStyleMethods = view._lyricRows.map(row => row.remove_style_class_name);
    for (const [index, row] of view._lyricRows.entries()) {
        row.remove_style_class_name = function (name) {
            styledRows.add(index);
            return removeStyleMethods[index].call(this, name);
        };
    }
    try {
        for (const index of [21, 3, -1, 20]) {
            styledRows.clear();
            const previous = view._activeLyricIndex;
            view.setCurrentLyricIndex(index);
            assert(styledRows.size <= (previous < 0 || index < 0 ? lines.length : 10),
                'line changes must update at most the two five-row neighborhoods');
            for (const [rowIndex, row] of view._lyricRows.entries()) {
                assert(row.has_style_class_name(
                    `lyric-glance-line-${getLineVisualLevel(rowIndex, index).name}`),
                'adjacent lines, distant seeks and entering/leaving no selection must retain every visual level');
            }
        }
    } finally {
        for (const [index, row] of view._lyricRows.entries())
            row.remove_style_class_name = removeStyleMethods[index];
    }
    assert(view._panelLabelView._label.text.startsWith('Synchronized lyric'),
        'the top-bar lyric should still update');

    view.setTranslationEnabled(true);
    view.setTranslation({lines: [{
        lineId: lines[20].lineId,
        text: '<b>安全译文</b> & مرحبا',
    }]});
    view.setTranslationState('available');
    assert(view._translationLabels[20].visible &&
        view._translationLabels[20].clutter_text.get_text() ===
            '<b>安全译文</b> & مرحبا' &&
        view._translationLabels[19].visible === false,
    'bilingual rows should align by line ID and treat translation as plain text');
    assert(view._lyricRows.every((row, index) => row === originalRows[index]),
        'translation arrival must not rebuild lyric rows');
    view.setTranslationState('network_error');
    assert(view._translationStatusLabel.text ===
        uiText('Translation network error', '翻译网络错误', '翻譯網路錯誤'),
        'translation failure should remain a compact secondary state');
    view.setTranslationState('network_error', {networkReason: 'timeout'});
    assert(view._translationStatusLabel.text === uiText(
        'Translation request timed out', '翻译请求超时', '翻譯請求逾時'),
    'transport diagnostics should be localized in the popup');
    for (const [status, expected] of [
        ['permission_denied', uiText('Translation access was denied', '翻译访问被拒绝', '翻譯存取遭拒')],
        ['quota_exceeded', uiText('Translation quota or spending limit reached',
            '翻译额度或消费限额已用尽', '翻譯額度或消費限額已用盡')],
    ]) {
        view.setTranslationState(status);
        assert(view._translationStatusLabel.text === expected,
            'access and quota failures should have distinct localized popup messages');
    }
    view.setTranslationState('available');
    view.setTranslationDisplayMode('translated');
    assert(!view._lyricLabels[20].visible &&
        view._translationLabels[20].visible &&
        view._lyricLabels[19].visible,
    'translated-only mode should fall back to original for a missing line');
    view.setTranslationDisplayMode('bilingual');

    indicator.menu.open();
    await Scripting.sleep(500);
    assert(indicator.menu.isOpen,
        'the native PanelMenu popup should open');
    assert(view._progressView._slider.width > 0,
        'the native progress slider should have an allocated hit area');
    assert(Boolean(instance._progressTimerId) === (instance._state?.playbackStatus === 'Playing'),
        'an open popup should run a progress timer only while playing');
    assert(view._scrollView.vadjustment.value > 0,
        'opening the popup should scroll a later current row into view');
    const anchorRow = view._lyricRows[20];
    const [, anchorY] = anchorRow.get_transformed_position();
    view.setTranslation({
        lines: lines.map((line, index) => ({
            lineId: line.lineId,
            text: index === 20
                ? '第 21 行安全译文 · مرحبا'
                : `第 ${index + 1} 行译文`,
        })),
    });
    await Scripting.sleep(120);
    const [, anchoredY] = anchorRow.get_transformed_position();
    print(`translationAnchorDelta=${(anchoredY - anchorY).toFixed(1)}`);
    assert(view._lyricRows.every((row, index) => row === originalRows[index]) &&
        Math.abs(anchoredY - anchorY) < 1.5,
    'late translation should update existing rows and preserve the current line position');

    const popupWidth = view.actor.menu.box.width;
    const headerHeight = view._artworkView.actor.get_parent().height;
    print(`mediaHeader=${headerHeight.toFixed(1)},` +
        `artwork=${view._artworkView.actor.width.toFixed(1)}x` +
        `${view._artworkView.actor.height.toFixed(1)}`);
    view.updateMetadataDisplay({title: 'Short', artist: 'Artist', album: ''});
    await Scripting.sleep(80);
    view.updateMetadataDisplay({
        title: 'An extremely long title that deliberately wraps across the full two-line title allowance',
        artist: 'An artist name long enough to require ellipsizing',
        album: 'An album name long enough to require ellipsizing',
    });
    await Scripting.sleep(80);
    assert(headerHeight === 80 && view.actor.menu.box.width === popupWidth &&
        view._artworkView.actor.get_parent().height === headerHeight,
    'short, long, and missing metadata should keep popup/header geometry stable');
    view.updateMetadataDisplay({
        title: 'A deliberately very long title used to exercise ellipsizing',
        artist: 'Test Artist',
        album: 'Test Album',
    });

    const mediaCommands = [];
    const originalMediaControl = view._onMediaControl;
    view._onMediaControl = async (action, target, position) => {
        mediaCommands.push({action, target, position});
    };
    const mediaState = {
        playbackStatus: 'Paused',
        controlTarget: {busName: 'test-player', generation: 1, trackKey: 'first'},
        metadata: {trackId: '/test/first', durationUs: 220_000_000},
        capabilities: {CanControl: true, CanPlay: true, CanPause: true,
            CanGoNext: true, CanGoPrevious: true, CanSeek: true},
    };
    view.setMediaState(mediaState);
    view.setProgress(60_000_000, 220_000_000);
    const progress = view._progressView;
    const slider = progress._slider;
    assert(Math.abs(slider.value - 60 / 220) < 0.0001 && mediaCommands.length === 0,
        'automatic progress updates must not seek');
    for (const action of ['Play', 'Previous', 'Next']) {
        view._mediaButtons.get(action).emit('clicked', 1);
        await Scripting.sleep(10);
        assert(mediaCommands.at(-1).action === action && indicator.menu.isOpen,
            `${action} should dispatch without closing the popup`);
    }
    mediaState.playbackStatus = 'Playing';
    view.setMediaState(mediaState);
    view._mediaButtons.get('Play').emit('clicked', 1);
    await Scripting.sleep(10);
    assert(mediaCommands.at(-1).action === 'Pause',
        'the playing button should dispatch Pause');
    const beforeDrag = mediaCommands.length;
    slider.emit('drag-begin');
    slider.value = 0.5;
    slider.value = 0.6;
    view.setProgress(61_000_000, 220_000_000);
    const requestBeforeEquivalentTarget = view._mediaRequest;
    view.setMediaState({...mediaState, controlTarget: {
        trackKey: mediaState.controlTarget.trackKey,
        generation: mediaState.controlTarget.generation,
        busName: mediaState.controlTarget.busName,
    }});
    assert(progress._dragTarget && view._mediaRequest === requestBeforeEquivalentTarget,
        'equivalent control targets with reordered properties must preserve the active drag and request');
    assert(slider.value === 0.6 && progress._currentLabel.text === '2:12' &&
        mediaCommands.length === beforeDrag,
    'dragging should preview time, resist clock updates, and send no command');
    slider.emit('drag-end');
    await Scripting.sleep(10);
    assert(mediaCommands.length === beforeDrag + 1 &&
        mediaCommands.at(-1).action === 'SetPosition' &&
        mediaCommands.at(-1).position === 132_000_000,
    'releasing a drag should submit one seek in microseconds');
    slider.value = 0.7;
    await Scripting.sleep(10);
    assert(mediaCommands.at(-1).position === 154_000_000,
        'non-drag slider changes should submit a seek');
    slider.step(1);
    await Scripting.sleep(10);
    view.setProgress(20_000_000, 220_000_000);
    slider.step(1);
    await Scripting.sleep(10);
    assert(Math.abs(mediaCommands.at(-1).position - 24_400_000) < 1,
        'native keyboard/scroll stepping must start from the latest clock position');

    const immediateMediaControl = view._onMediaControl;
    let resolveSeek;
    view._onMediaControl = () => new Promise(resolve => (resolveSeek = resolve));
    view.setProgress(20_000_000, 220_000_000);
    slider.emit('drag-begin');
    slider.value = 0.5;
    slider.emit('drag-end');
    view.setProgress(21_000_000, 220_000_000);
    assert(slider.value === 0.5 && progress._currentLabel.text === '1:50' &&
        progress._seekPending && view._mediaBusy && slider.can_focus && !slider.reactive,
    'a pending seek must retain its preview and keyboard focusability despite an old clock tick');
    view.setProgress(111_000_000, 220_000_000);
    assert(slider.value === 0.5,
        'authoritative progress should be recorded without replacing the pending preview');
    resolveSeek(true);
    await Scripting.sleep(10);
    assert(Math.abs(slider.value - 111 / 220) < 0.0001 &&
        progress._currentLabel.text === '1:51' && !progress._seekPending && !view._mediaBusy,
    'seek completion must reveal the latest authoritative progress');

    for (const rejected of [false, new Error('Expected seek rejection')]) {
        let settleSeek;
        view._onMediaControl = () => new Promise((resolve, reject) => {
            settleSeek = () => rejected === false ? resolve(false) : reject(rejected);
        });
        view.setProgress(20_000_000, 220_000_000);
        slider.value = 0.5;
        view.setProgress(21_000_000, 220_000_000);
        settleSeek();
        await Scripting.sleep(10);
        assert(Math.abs(slider.value - 21 / 220) < 0.0001 &&
            progress._currentLabel.text === '0:21' && !progress._seekPending &&
            !view._mediaBusy && view._mediaErrorLabel.visible,
        'a rejected or failed seek must restore actual progress and report failure');
    }

    view._onMediaControl = () => new Promise(resolve => (resolveSeek = resolve));
    view.setProgress(20_000_000, 220_000_000);
    slider.value = 0.5;
    view.setMediaState({...mediaState, controlTarget:
        {...mediaState.controlTarget, trackKey: 'pending-replacement'}});
    view.setProgress(5_000_000, 220_000_000);
    resolveSeek(false);
    await Scripting.sleep(10);
    assert(Math.abs(slider.value - 5 / 220) < 0.0001 && !progress._seekPending &&
        !view._mediaErrorLabel.visible,
    'a stale seek completion must not replace the new track progress or show its error');
    view.setMediaState(mediaState);
    view.setProgress(20_000_000, 220_000_000);
    slider.value = 0.5;
    view.cancelMediaDrag();
    assert(!progress._seekPending && Math.abs(slider.value - 20 / 220) < 0.0001,
        'closing the popup must discard an unconfirmed seek preview');
    view.setProgress(22_000_000, 220_000_000);
    resolveSeek(true);
    await Scripting.sleep(10);
    assert(Math.abs(slider.value - 22 / 220) < 0.0001,
        'completion after closing must retain the latest authoritative progress');
    view._onMediaControl = immediateMediaControl;

    let finishDestroyedSeek;
    const pendingView = new view.constructor('Pending seek lifecycle fixture', {
        onMediaControl: () => new Promise(resolve => (finishDestroyedSeek = resolve)),
    });
    pendingView.setMediaState(mediaState);
    pendingView.setProgress(20_000_000, 220_000_000);
    const pendingProgress = pendingView._progressView;
    const progressDestroyed = new Set();
    for (const [name, actor] of [
        ['container', pendingProgress.actor],
        ['slider', pendingProgress._slider],
        ['current', pendingProgress._currentLabel],
        ['duration', pendingProgress._durationLabel],
    ]) {
        actor.connect('destroy', () => progressDestroyed.add(name));
    }
    pendingProgress._slider.value = 0.5;
    assert(pendingProgress._seekPending, 'the lifecycle fixture must have an active seek');
    pendingProgress.destroy();
    assert(progressDestroyed.size === 4,
        'destroying the progress view must destroy its container, slider and labels before its parent');
    const pendingPanelLabel = pendingView._panelLabelView;
    const panelLabelDestroyed = new Set();
    for (const [name, actor] of [
        ['viewport', pendingPanelLabel.actor],
        ['label', pendingPanelLabel._label],
        ['panLabel', pendingPanelLabel._panLabel],
        ['titleCopy', pendingPanelLabel._titleCopy],
    ])
        actor.connect('destroy', () => panelLabelDestroyed.add(name));
    pendingPanelLabel.setHovered(true);
    pendingPanelLabel.destroy();
    assert(panelLabelDestroyed.size === 4 && pendingPanelLabel.actor === null &&
        !pendingPanelLabel._hovered && pendingPanelLabel._panLaterId === 0 &&
        pendingPanelLabel._geometryLaterId === 0,
        'destroying the panel label view must destroy its viewport and labels before its parent');
    pendingPanelLabel.setHovered(true);
    pendingPanelLabel.onMenuOpenChanged(false);
    pendingPanelLabel.setText('after destroy', {scrollable: true, loop: true});
    pendingPanelLabel.setPlaying(true);
    pendingPanelLabel.destroy();
    pendingView.setText('after destroy');
    pendingView.destroy();
    finishDestroyedSeek(true);
    await Scripting.sleep(10);
    assert(!pendingProgress._seekPending && pendingProgress._slider === null,
        'destroying a pending seek must release its preview and ignore later completion');

    const beforeCancelled = mediaCommands.length;
    slider.emit('drag-begin');
    slider.value = 0.8;
    view.setMediaState({...mediaState, controlTarget:
        {...mediaState.controlTarget, trackKey: 'second'}});
    slider.emit('drag-end');
    await Scripting.sleep(10);
    assert(mediaCommands.length === beforeCancelled,
        'switching tracks while dragging must cancel the seek');
    view.setMediaState(mediaState);
    slider.emit('drag-begin');
    slider.value = 0.4;
    view.setMediaState({...mediaState, controlTarget:
        {...mediaState.controlTarget, busName: 'other-player', generation: 2}});
    slider.emit('drag-end');
    await Scripting.sleep(10);
    assert(mediaCommands.length === beforeCancelled,
        'switching players while dragging must cancel the seek');
    view.setMediaState(mediaState);
    slider.emit('drag-begin');
    slider.value = 0.2;
    view.cancelMediaDrag();
    slider.emit('drag-end');
    await Scripting.sleep(10);
    assert(mediaCommands.length === beforeCancelled,
        'closing a popup must cancel an uncommitted seek');
    view.setMediaState({...mediaState, capabilities: {CanControl: false}});
    assert(!slider.reactive && !view._mediaButtons.get('Play').reactive,
        'unsupported media controls must be disabled');
    view.setMediaState({...mediaState, metadata: {...mediaState.metadata, trackId: ''}});
    assert(!slider.reactive, 'missing track IDs must disable absolute seeking');
    view.setMediaState(mediaState);
    view._onMediaControl = async () => { throw new Error('Expected media test failure'); };
    view._mediaButtons.get('Play').emit('clicked', 1);
    await Scripting.sleep(10);
    assert(view._mediaErrorLabel.visible && view._mediaButtons.get('Play').reactive,
        'a failed control must show an error and restore the controls');
    let rejectOldControl;
    view._onMediaControl = () => new Promise((_resolve, reject) => {
        rejectOldControl = reject;
    });
    view._mediaButtons.get('Play').emit('clicked', 1);
    assert(!view._mediaButtons.get('Play').reactive && !slider.reactive,
        'pending commands must disable controls to prevent duplicate requests');
    view.setMediaState({...mediaState, controlTarget:
        {...mediaState.controlTarget, generation: 2}});
    rejectOldControl(new Error('Expected stale control failure'));
    await Scripting.sleep(10);
    assert(!view._mediaErrorLabel.visible && view._mediaButtons.get('Play').reactive,
        'a stale control completion must not change the replacement player UI');
    view._onMediaControl = originalMediaControl;
    view.setMediaState(null);
    view.setProgress(119_000_000, 220_000_000);
    assert(Math.abs(slider.value - 119 / 220) < 0.0001,
        'native slider progress should reposition directly after a seek');

    view.setPlayers([{
        stableId: 'desktop:firefox',
        displayName: 'Mozilla Firefox',
        selected: true,
    }], 'auto');
    assert(view._playerMenu.label.clutter_text.get_text() ===
        uiText('Player   Mozilla Firefox', '播放器   Mozilla Firefox'),
    'the native player submenu row should separate its secondary label and value');

    const screenshotPath = GLib.getenv('LYRIC_GLANCE_SCREENSHOT_PATH');
    const screenshotKind = GLib.getenv('LYRIC_GLANCE_SCREENSHOT_KIND') ??
        'bilingual';
    const screenshotPanelText = GLib.getenv(
        'LYRIC_GLANCE_SCREENSHOT_PANEL_TEXT');
    const screenshotPanelPosition = GLib.getenv(
        'LYRIC_GLANCE_SCREENSHOT_PANEL_POSITION');
    if (screenshotPanelPosition)
        settings.set_string('panel-position', screenshotPanelPosition);
    if (screenshotPanelText) {
        view.setText(screenshotPanelText);
        await Scripting.sleep(180);
    }
    if (screenshotKind === 'panel') {
        indicator.menu.close();
        await Scripting.sleep(250);
    } else if (screenshotKind === 'popup') {
        view.setTranslationDisplayMode('original');
    } else if (screenshotKind === 'word') {
        view.setLyrics({
            source: 'test',
            sourceId: null,
            instrumental: false,
            metadata: {},
            syncLevel: 'word',
            lines: [{
                lineId: 'screenshot-word-line',
                text: 'Safe multilingual word sync · שלום 世界',
                startMs: 0,
                endMs: 3000,
                words: [
                    {text: 'Safe ', startMs: 0, endMs: 800},
                    {text: 'multilingual ', startMs: 800, endMs: 1600},
                    {text: 'word sync · שלום ', startMs: 1600, endMs: 2400},
                    {text: '世界', startMs: 2400, endMs: 3000},
                ],
            }],
        });
        view.setTranslation({lines: [{
            lineId: 'screenshot-word-line',
            text: '安全的多语言逐字同步',
        }]});
        view.setCurrentLyricIndex(0, {reposition: true});
        view.setCurrentWordStates(0,
            ['past', 'past', 'current', 'future']);
        view._scrollView.vadjustment.value = 0;
        await Scripting.sleep(250);
    }
    if (screenshotPath)
        await takeScreenshot(screenshotPath);
    if (screenshotKind === 'panel') {
        indicator.menu.open();
        await Scripting.sleep(250);
    } else if (screenshotKind === 'popup') {
        view.setTranslationDisplayMode('bilingual');
        view.setCurrentLyricIndex(20, {reposition: true});
        await Scripting.sleep(250);
    } else if (screenshotKind === 'word') {
        view.setLyrics(lineDocument);
        view.setTranslation({
            lines: lines.map((line, index) => ({
                lineId: line.lineId,
                text: index === 20
                    ? '第 21 行安全译文 · مرحبا'
                    : `第 ${index + 1} 行译文`,
            })),
        });
        view.setCurrentLyricIndex(20, {reposition: true});
        await Scripting.sleep(250);
        originalRows = [...view._lyricRows];
    }
    if (screenshotPanelText)
        view.setText('Synchronized lyric line 21 with wrapping text');
    if (screenshotPanelPosition)
        settings.set_string('panel-position', 'center');

    const comfortableValue = view._scrollView.vadjustment.value;
    const comfortablePage = view._scrollView.vadjustment.page_size;
    const currentBounds = view._rowVerticalBounds(view._lyricRows[20]);
    const nextBounds = view._rowVerticalBounds(view._lyricRows[21]);
    const distantBounds = view._rowVerticalBounds(view._lyricRows[23]);
    print(`lyricLayout=viewport:${comfortablePage.toFixed(1)},` +
        `current:${(currentBounds.y2 - currentBounds.y1).toFixed(1)},` +
        `near:${(nextBounds.y2 - nextBounds.y1).toFixed(1)},` +
        `far:${(distantBounds.y2 - distantBounds.y1).toFixed(1)}`);
    assert(comfortablePage <= 300 &&
        currentBounds.y2 - currentBounds.y1 >
        nextBounds.y2 - nextBounds.y1 &&
        nextBounds.y2 - nextBounds.y1 >
        distantBounds.y2 - distantBounds.y1,
    'the compact viewport should retain progressive lyric breathing room');
    print(`comfortableFractions=${(((currentBounds.y1 + currentBounds.y2) / 2 -
        comfortableValue) / comfortablePage).toFixed(2)},${(((nextBounds.y1 +
        nextBounds.y2) / 2 - comfortableValue) / comfortablePage).toFixed(2)}`);
    view.setCurrentLyricIndex(21);
    await Scripting.sleep(260);
    print(`comfortableScrollDelta=${(view._scrollView.vadjustment.value -
        comfortableValue).toFixed(1)}`);
    assert(view._lyricRows.every((row, index) => row === originalRows[index]),
        'a lyric change must reuse the existing row objects');
    assert(!view._lyricRows[20].has_style_class_name(
        'lyric-glance-line-current'),
        'the previous row should lose the current class');
    assert(view._lyricRows[21].has_style_class_name(
        'lyric-glance-line-current'),
        'the new row should gain the current class');
    assert(Math.abs(view._scrollView.vadjustment.value - comfortableValue) < 1,
        'an adjacent line inside the comfortable zone should not scroll');
    view.setCurrentLyricIndex(20, {reposition: true});
    await Scripting.sleep(100);
    const settledValue = view._scrollView.vadjustment.value;
    const expandedPage = view._scrollView.vadjustment.page_size;
    view._mediaErrorLabel.show();
    await Scripting.sleep(100);
    const shrunkPage = view._scrollView.vadjustment.page_size;
    view._mediaErrorLabel.hide();
    view.setCurrentLyricIndex(21);
    await Scripting.sleep(260);
    assert(shrunkPage < expandedPage &&
        view._scrollView.vadjustment.page_size === expandedPage &&
        !view._scrollStageSignalId &&
        Math.abs(view._scrollView.vadjustment.value - settledValue) < 1,
    'a line change queued alongside a sibling relayout must wait for the updated viewport before scrolling');
    view.setCurrentLyricIndex(20, {reposition: true});
    await Scripting.sleep(100);
    view.setCurrentLyricIndex(5, {reposition: true});
    view.setCurrentLyricIndex(-1);
    view.setCurrentLyricIndex(21);
    await Scripting.sleep(260);
    assert(!view._scrollStageSignalId &&
        Math.abs(view._scrollView.vadjustment.value - settledValue) < 1,
    'clearing the active lyric must cancel any pending forced reposition');
    const savedArtistText = view._artistLabel.text;
    let relayoutTicks = 0;
    let relayoutTimerId = GLib.timeout_add(GLib.PRIORITY_HIGH, 10, () => {
        relayoutTicks++;
        view._artistLabel.text = `${savedArtistText} ${'x'.repeat(relayoutTicks % 5 + 1)}`;
        if (relayoutTicks < 20)
            return GLib.SOURCE_CONTINUE;
        relayoutTimerId = 0;
        return GLib.SOURCE_REMOVE;
    });
    try {
        view.setCurrentLyricIndex(2, {reposition: true});
        await Scripting.sleep(260);
        assert(!view._scrollStageSignalId &&
            view._scrollView.vadjustment.value < settledValue - 100,
        'continuous sibling relayouts must not drop a scheduled lyric scroll');
    } finally {
        if (relayoutTimerId)
            GLib.source_remove(relayoutTimerId);
        view._artistLabel.text = savedArtistText;
    }
    view.setCurrentLyricIndex(21, {reposition: true});
    await Scripting.sleep(100);
    view.setCurrentLyricIndex(29, {reposition: true});
    await Scripting.sleep(60);
    assert(view._scrollView.vadjustment.value > comfortableValue,
        'a seek should immediately reposition to the latest distant line');

    const markupText = '<b>safe</b> & שלום 世界!';
    const wordDocument = {
        source: 'test',
        sourceId: null,
        instrumental: false,
        metadata: {},
        syncLevel: 'word',
        lines: [{
            lineId: 'word-line-0',
            text: markupText,
            startMs: 0,
            endMs: 3000,
            words: [
                {text: '<b>safe</b> ', startMs: 0, endMs: 1000},
                {text: '& ', startMs: 1000, endMs: 1500},
                {text: 'שלום ', startMs: 1500, endMs: 2200},
                {text: '世界!', startMs: 2200, endMs: 3000},
            ],
        }],
    };
    view.setLyrics(wordDocument);
    view.setTranslation({lines: [{
        lineId: 'word-line-0',
        text: '逐词同步的行级译文',
    }]});
    view.setCurrentLyricIndex(0, {reposition: true});
    view.setCurrentWordStates(0, ['past', 'current', 'future', 'future']);
    assert(view._lyricLabels[0].clutter_text.get_text() === markupText,
        'word highlighting must escape lyric text instead of injecting markup');
    const wordLabel = view._lyricLabels[0];
    const translatedWordLabel = view._translationLabels[0];
    view.setCurrentWordStates(0, ['past', 'past', 'current', 'future']);
    assert(view._lyricLabels[0] === wordLabel &&
        view._translationLabels[0] === translatedWordLabel &&
        translatedWordLabel.text === '逐词同步的行级译文',
    'a word change should update only the original current-line label');
    view.setTranslationDisplayMode('translated');
    assert(!view.isOriginalLineVisible(0),
        'translated-only mode should expose that original karaoke is hidden');
    view.setTranslationDisplayMode('bilingual');

    const longDocument = {
        ...lineDocument,
        syncLevel: 'none',
        lines: Array.from({length: 350}, (_unused, index) => ({
            lineId: `long-${index}`,
            text: `Static long-lyrics line ${index + 1}`,
            startMs: null,
            endMs: null,
            words: [],
        })),
    };
    const longLyricsStartUs = GLib.get_monotonic_time();
    view.setLyrics(longDocument);
    const longLyricsBuildMs =
        (GLib.get_monotonic_time() - longLyricsStartUs) / 1000;
    assert(view._lyricRows.length === 350 && longLyricsBuildMs < 1500,
        '350 static lines should build without an obvious Shell stall');
    print(`longLyricsBuildMs=${longLyricsBuildMs.toFixed(1)}`);

    const realMprisManager = instance._mprisManager;
    const realOffsetStore = instance._offsetStore;
    const realLyricsProvider = instance._lyricsProvider;
    const initialTranslationService = instance._translationService;
    let serviceCreations = 0;
    const origCreateService = instance._createTranslationService.bind(instance);
    instance._createTranslationService = () => {
        serviceCreations++;
        return origCreateService();
    };
    settings.set_string('translation-provider', 'custom-deepseek');
    settings.set_string('translation-api-endpoint', 'https://proxy.example/v1');
    settings.set_string('translation-api-protocol', 'chat-completions');
    settings.set_string('translation-model', 'custom-runtime-model');
    await Scripting.sleep(80);
    assert(serviceCreations === 1 &&
        instance._translationService !== initialTranslationService,
    `simultaneous backend changes should coalesce into one service replacement (count=${serviceCreations})`);
    assert(initialTranslationService._providers.size === 0,
        'replacing the translation service should destroy the old provider');
    assert(instance._translationService._providers.get('custom-deepseek').model ===
        'custom-runtime-model' &&
        instance._translationService._providers.get('custom-deepseek')._endpoint ===
            'https://proxy.example/v1/chat/completions' &&
        instance._translationService._providers.get('custom-deepseek')._protocol === 'chat-completions',
    'the replacement provider should use the custom provider ID, new model and resolved base address');
    settings.set_string('translation-providers', JSON.stringify([
        {
            id: 'openai',
            name: 'OpenAI',
            endpoint: 'https://api.openai.com/v1/responses',
            protocol: 'auto',
            models: ['gpt-5.4-mini-2026-03-17'],
            model: 'gpt-5.4-mini-2026-03-17',
        },
        {
            id: 'json-provider',
            name: 'JSON Provider',
            endpoint: 'https://json.example/v1',
            protocol: 'chat-completions',
            models: ['json-model-a', 'json-model-b'],
            model: 'json-model-a',
        },
    ]));
    settings.set_string('translation-provider', 'json-provider');
    await Scripting.sleep(80);
    assert(serviceCreations === 2 &&
        instance._activeTranslationProviderId() === 'json-provider' &&
        instance._translationService._providers.get('json-provider')?.model === 'json-model-a' &&
        instance._translationService._providers.get('json-provider')?._endpoint ===
            'https://json.example/v1/chat/completions',
    'translation-providers JSON plus translation-provider must drive runtime service configuration');
    settings.set_string('translation-model', 'stale-legacy-ignored');
    await Scripting.sleep(80);
    assert(serviceCreations === 2 &&
        instance._translationService._providers.get('json-provider')?.model === 'json-model-a',
    'stale legacy scalar key writes must not recreate or override a JSON-configured service');
    settings.set_string('translation-providers', JSON.stringify([
        {
            id: 'openai',
            name: 'OpenAI',
            endpoint: 'https://api.openai.com/v1/responses',
            protocol: 'auto',
            models: ['gpt-5.4-mini-2026-03-17'],
            model: 'gpt-5.4-mini-2026-03-17',
        },
        {
            id: 'json-provider',
            name: 'JSON Provider',
            endpoint: 'https://json.example/v1',
            protocol: 'chat-completions',
            models: ['json-model-a', 'json-model-b'],
            model: 'json-model-b',
        },
    ]));
    await Scripting.sleep(80);
    assert(serviceCreations === 3 &&
        instance._translationService._providers.get('json-provider')?.model === 'json-model-b',
    'direct updates to the active provider in translation-providers must replace the runtime service');
    settings.set_string('translation-providers', JSON.stringify([
        {
            id: 'openai',
            name: 'OpenAI Renamed',
            endpoint: 'https://api.openai.com/v1/responses',
            protocol: 'auto',
            models: ['gpt-5.4-mini-2026-03-17'],
            model: 'gpt-5.4-mini-2026-03-17',
        },
        {
            id: 'json-provider',
            name: 'JSON Provider',
            endpoint: 'https://json.example/v1',
            protocol: 'chat-completions',
            models: ['json-model-a', 'json-model-b'],
            model: 'json-model-b',
        },
    ]));
    await Scripting.sleep(80);
    assert(serviceCreations === 3,
        'editing an inactive provider in translation-providers must not recreate the active service');
    settings.set_string('translation-provider', 'openai');
    settings.set_string('translation-provider', 'json-provider');
    await Scripting.sleep(80);
    assert(serviceCreations === 4 &&
        instance._activeTranslationProviderId() === 'json-provider' &&
        instance._translationService._providers.has('json-provider'),
    'rapid A -> B -> A switching inside the coalesce window must finish service replacement instead of stranding canceled work');
    settings.set_string('translation-providers', '');
    settings.set_string('translation-provider', '../invalid-id');
    settings.set_string(
        'translation-api-endpoint', 'https://api.openai.com/v1/responses');
    settings.set_string('translation-api-protocol', 'auto');
    settings.set_string(
        'translation-model', 'gpt-5.4-mini-2026-03-17');
    await Scripting.sleep(80);
    assert(serviceCreations === 5 &&
        instance._activeTranslationProviderId() === 'openai' &&
        instance._translationService._providers.has('openai'),
    'invalid legacy translation-provider IDs must normalize to openai in the runtime service');
    instance._createTranslationService = origCreateService;
    settings.set_string('translation-providers', '');
    settings.set_string('translation-provider', 'openai');
    settings.set_string(
        'translation-api-endpoint', 'https://api.openai.com/v1/responses');
    settings.set_string('translation-api-protocol', 'auto');
    settings.set_string(
        'translation-model', 'gpt-5.4-mini-2026-03-17');
    await Scripting.sleep(80);
    const realTranslationService = instance._translationService;
    let runtimeCacheClears = 0;
    let lyricFetches = 0;
    instance._lyricsProvider = {
        clearCaches: async () => runtimeCacheClears++,
        cancelPending() {},
        fetch(_metadata, callback) {
            lyricFetches++;
            callback(lineDocument);
        },
    };
    let translationRequests = 0;
    const translationForceRequests = [];
    const translationIgnoreSameRequests = [];
    let translationCacheClears = 0;
    instance._translationService = {
        cancelAll() {},
        clearCache: async () => translationCacheClears++,
        translate(document, request) {
            translationRequests++;
            translationForceRequests.push(request.forceRefresh);
            translationIgnoreSameRequests.push(Boolean(request.ignoreSameLanguage));
            request.onStatus?.({status: 'loading'});
            return Promise.resolve({
                status: 'available',
                fromCache: translationRequests > 1,
                document: {
                    version: 1,
                    trackKey: request.trackKey,
                    sourceLyricsHash: sourceLyricsHash(document),
                    sourceLanguage: 'en',
                    targetLanguage: request.targetLanguage,
                    provider: request.providerId,
                    model: 'mock-v1',
                    createdAt: new Date().toISOString(),
                    lines: document.lines
                        .filter(line => line.text)
                        .map(line => ({
                            lineId: line.lineId,
                            text: `[zh-CN] ${line.text}`,
                        })),
                },
            });
        },
        destroy() {},
    };
    const storedOffsets = new Map();
    instance._offsetStore = {
        get: metadata => storedOffsets.get(metadata.title) ?? 0,
        set: (metadata, value) => {
            if (value === 0)
                storedOffsets.delete(metadata.title);
            else
                storedOffsets.set(metadata.title, value);
            return value;
        },
        destroy() {},
    };
    const availablePlayers = [
        {
            stableId: 'desktop:firefox',
            displayName: 'Firefox',
            selected: true,
        },
        {
            stableId: 'desktop:vlc',
            displayName: 'VLC media player',
            selected: false,
        },
    ];
    let appliedPreference = 'auto';
    let fakePositionUs = 1_750_000;
    instance._mprisManager = {
        getPositionUs: () => fakePositionUs,
        getDelayUntilPositionUs: targetUs =>
            Math.max(1, (targetUs - fakePositionUs) / 1000),
        getPlayers: () => availablePlayers,
        setPreferredPlayer: value => (appliedPreference = value),
    };

    const stableMetadata = {
        trackId: '/org/mpris/MediaPlayer2/track/1',
        title: 'Stable Track',
        artist: 'Stable Artist',
        album: 'Stable Album',
        artUrl: '',
        durationUs: 220_000_000,
    };
    instance._onPlayerStateChanged({
        busName: 'org.mpris.MediaPlayer2.test',
        playbackStatus: 'Paused',
        positionUs: 0,
        metadata: stableMetadata,
    });
    const stableRows = [...view._lyricRows];
    instance._onPlayerStateChanged({
        busName: 'org.mpris.MediaPlayer2.test',
        playbackStatus: 'Paused',
        positionUs: 0,
        metadata: {...stableMetadata, artUrl: localArtwork.get_uri()},
    });
    instance._onPlayerStateChanged({
        busName: 'org.mpris.MediaPlayer2.test',
        playbackStatus: 'Paused',
        positionUs: 0,
        metadata: {...stableMetadata, album: 'Corrected Album',
            artUrl: localArtwork.get_uri()},
    });
    assert(lyricFetches === 1 &&
        view._lyricRows.every((row, index) => row === stableRows[index]) &&
        view._albumLabel.text === 'Corrected Album',
    'artUrl and display-only metadata changes must not refetch or rebuild lyrics');
    indicator.menu.open();
    assert(instance._progressTimerId === 0, 'an open paused popup must have no progress source');
    instance._onPlayerStateChanged({...instance._state, positionUs: 14_000_000});
    assert(instance._progressTimerId === 0 &&
        Math.abs(view._progressView._slider.value - 14_000_000 / stableMetadata.durationUs) < 0.0001,
    'paused seek feedback must update progress immediately without starting a timer');

    instance._onPlayerStateChanged({
        busName: 'org.mpris.MediaPlayer2.test',
        playbackStatus: 'Playing',
        positionUs: 0,
        metadata: {
            ...stableMetadata,
            title: 'Replacement Track',
            artist: 'Replacement Artist',
            album: 'Replacement Album',
            durationUs: 205_000_000,
        },
    });
    assert(lyricFetches === 2 &&
        view._titleLabel.text === 'Replacement Track' &&
        view._artistLabel.text === 'Replacement Artist' &&
        view._lyricRows.some((row, index) => row !== stableRows[index]),
    'changed track metadata must refetch lyrics when Firefox reuses TrackId');
    assert(instance._progressTimerId !== 0, 'resuming playback in an open popup must start progress updates');
    const resumedState = instance._state;
    instance._onPlayerStateChanged({...resumedState, playbackStatus: 'Paused'});
    assert(instance._progressTimerId === 0, 'pausing must stop the progress source immediately');
    instance._onPlayerStateChanged(resumedState);
    assert(instance._progressTimerId !== 0, 'playing again must restore exactly one progress source');

    const immediateLyricsProvider = instance._lyricsProvider;
    const delayedLookups = [];
    const delayedCacheClears = [];
    instance._lyricsProvider = {
        cancelPending() {},
        clearCaches() {
            return new Promise((resolve, reject) => delayedCacheClears.push({resolve, reject}));
        },
        fetch(metadata, callback, onStatus) {
            delayedLookups.push({metadata, callback, onStatus});
        },
    };
    const delayedState = title => ({
        busName: 'org.mpris.MediaPlayer2.test', playbackStatus: 'Playing', positionUs: 0,
        metadata: {...stableMetadata, title},
    });
    instance._onPlayerStateChanged(delayedState('Retry A'));
    delayedLookups[0].onStatus({status: 'retrying', document: null});
    assert(view._messageLabel.text === uiText('Retrying lyrics…', '正在重试歌词…', '正在重試歌詞…') &&
        view._panelLabelView._looping,
    'a retry must show a retry message and keep the panel title available');
    instance._onPlayerStateChanged(delayedState('Retry B'));
    delayedLookups[1].callback(null, 'unavailable');
    assert(view._messageLabel.text === uiText(
        'Lyrics service temporarily unavailable', '歌词服务暂不可用', '歌詞服務暫時無法使用'),
    'an exhausted lookup must not be presented as confirmed missing lyrics');
    instance._onPlayerStateChanged(delayedState('Retry C'));
    fakePositionUs = 23_500_000;
    delayedLookups[2].callback(lineDocument, 'complete');
    assert(instance._currentLyricIndex === 23 &&
        view._panelLabelView._label.text === lineDocument.lines[23].text &&
        view._panelLabelView._timeline.positionMs === 23_500,
    'late lyrics must align the row and panel timeline with the current playback clock');
    delayedLookups[0].onStatus({status: 'retrying', document: null});
    delayedLookups[0].callback(null, 'unavailable');
    assert(instance._lyricsDocument === lineDocument && instance._currentLyricIndex === 23,
        'old-song retry and completion callbacks must not replace the current lyrics');
    instance._onPlayerStateChanged(delayedState('Retry D'));
    delayedLookups[3].callback(null, 'complete');
    assert(view._messageLabel.text === uiText('No lyrics found', '未找到歌词', '找不到歌詞'),
        'a successful empty lookup must retain the confirmed-missing message');
    for (const phase of ['loading', 'retrying', 'loaded']) {
        instance._onPlayerStateChanged(delayedState(`Cache Clear ${phase}`));
        if (phase === 'retrying')
            delayedLookups.at(-1).onStatus({status: 'retrying', document: null});
        else if (phase === 'loaded')
            delayedLookups.at(-1).callback(lineDocument);
        const beforeClear = delayedLookups.length;
        settings.set_int('cache-clear-generation', settings.get_int('cache-clear-generation') + 1);
        assert(delayedLookups.length === beforeClear,
            'cache clearing must finish before restarting the current lookup');
        delayedCacheClears.at(-1).resolve();
        await Scripting.sleep(10);
        assert(delayedLookups.length === beforeClear + 1 && !instance._lyricsLoaded,
            `${phase}: clearing lyrics caches must restart the current lookup`);
        delayedLookups.at(-1).callback(null, 'complete');
        assert(instance._lyricsLoaded && view._panelLabelView._looping &&
            view._messageLabel.text === uiText('No lyrics found', '未找到歌词', '找不到歌詞'),
        `${phase}: a cleared lookup must reach a terminal state and restore title looping`);
    }
    instance._onPlayerStateChanged(delayedState('Cache Clear Old Track'));
    settings.set_int('cache-clear-generation', settings.get_int('cache-clear-generation') + 1);
    instance._onPlayerStateChanged(delayedState('Cache Clear Current Track'));
    delayedCacheClears.at(-1).resolve();
    await Scripting.sleep(10);
    assert(delayedLookups.at(-1).metadata.title === 'Cache Clear Current Track',
        'finishing cache clearing must reload the current song rather than the captured old song');
    delayedLookups.at(-1).callback(lineDocument);
    assert(instance._lyricsDocument === lineDocument && instance._currentLyricIndex === 23,
        'reloaded lyrics must align with the current playback clock');

    settings.set_int('cache-clear-generation', settings.get_int('cache-clear-generation') + 1);
    delayedCacheClears.at(-1).reject(new Error('Expected runtime cache clear failure'));
    await Scripting.sleep(10);
    assert(!instance._lyricsLoaded,
        'a failed clear must still restart the cancelled lyric lookup');
    delayedLookups.at(-1).callback(null, 'unavailable');
    assert(view._messageLabel.text === uiText(
        'Lyrics service temporarily unavailable', '歌词服务暂不可用', '歌詞服務暫時無法使用'),
    'a failed clear must not leave a loading/retrying message permanently displayed');

    settings.set_int('cache-clear-generation', settings.get_int('cache-clear-generation') + 1);
    const firstClear = delayedCacheClears.at(-1);
    settings.set_int('cache-clear-generation', settings.get_int('cache-clear-generation') + 1);
    delayedCacheClears.at(-1).resolve();
    await Scripting.sleep(10);
    const afterLatestClear = delayedLookups.length;
    firstClear.resolve();
    await Scripting.sleep(10);
    assert(delayedLookups.length === afterLatestClear,
        'an older cache clear must not cancel or restart the newest lookup');
    delayedLookups.at(-1).callback(null, 'complete');
    assert(instance._lyricsLoaded && view._panelLabelView._looping,
        'overlapping cache clears must leave a completable current lookup');

    settings.set_int('cache-clear-generation', settings.get_int('cache-clear-generation') + 1);
    instance._onPlayerStateChanged(null);
    const beforeNoPlayer = delayedLookups.length;
    delayedCacheClears.at(-1).resolve();
    await Scripting.sleep(10);
    assert(delayedLookups.length === beforeNoPlayer && !indicator.visible,
        'cache clearing must not restart a lookup after the player disappears');
    instance._onPlayerStateChanged(delayedState('Cache Clear Provider Replacement'));
    settings.set_int('cache-clear-generation', settings.get_int('cache-clear-generation') + 1);
    instance._lyricsProvider = immediateLyricsProvider;
    const fetchesBeforeReplacement = lyricFetches;
    delayedCacheClears.at(-1).resolve();
    await Scripting.sleep(10);
    assert(lyricFetches === fetchesBeforeReplacement,
        'an old provider finishing cache clearing must not restart the replacement provider');
    view.setLyrics(null);
    delayedLookups[3].onStatus({status: 'retrying', document: null});
    assert(view._messageLabel.text === uiText('No lyrics found', '未找到歌词', '找不到歌詞'),
        'replacing the provider must invalidate its status callbacks');
    // Removing the player hid the panel and closed its menu. Restore the
    // open popup required by the following word-synchronization fixtures.
    indicator.menu.open();
    fakePositionUs = 1_750_000;

    const offsetMetadata = {
        title: 'Offset Test',
        artist: 'Paused Artist',
        album: 'Synchronization',
        durationUs: 180_000_000,
    };
    const offsetLines = [
        {lineId: 'offset-0', startMs: 1000, endMs: null, words: [], text: 'First'},
        {lineId: 'offset-1', startMs: 2000, endMs: null, words: [], text: 'Second'},
        {lineId: 'offset-2', startMs: 3000, endMs: null, words: [], text: 'Third'},
    ];
    const offsetDocument = {
        source: 'test',
        sourceId: null,
        instrumental: false,
        metadata: {},
        syncLevel: 'line',
        lines: offsetLines,
    };
    instance._state = {
        playbackStatus: 'Paused',
        metadata: offsetMetadata,
    };
    instance._lyricsDocument = offsetDocument;
    instance._currentTrackKey = 'offset-test-key';
    instance._lyricsLoaded = true;
    instance._trackOffsetMs = 0;
    instance._currentLyricIndex = -1;

    const distantBoundaryMs = 5_000_000_000;
    const assertBoundedSource = (id, message) => {
        const source = GLib.MainContext.default().find_source_by_id(id);
        const remainingMs = source &&
            (source.get_ready_time() - GLib.get_monotonic_time()) / 1000;
        assert(remainingMs > 0 && remainingMs <= 2_147_483_647, message);
    };
    fakePositionUs = 0;
    instance._state = {playbackStatus: 'Playing', metadata: offsetMetadata};
    instance._lyricsDocument = {...offsetDocument,
        lines: [{...offsetLines[0], startMs: distantBoundaryMs}]};
    view.setLyrics(instance._lyricsDocument);
    instance._updateIndicatorAndSchedule(true);
    const distantLineSource = instance._lineTimerId;
    assertBoundedSource(distantLineSource,
        'a distant lyric line must schedule a bounded native timeout');
    instance._stopLineTimer();
    assert(!GLib.MainContext.default().find_source_by_id(distantLineSource),
        'a distant lyric line source must remain cancellable');

    instance._lyricsDocument = {...offsetDocument, syncLevel: 'word', lines: [{
        lineId: 'distant-word', text: panningText, startMs: 0,
        endMs: distantBoundaryMs + 1000,
        words: [{text: panningText, startMs: distantBoundaryMs,
            endMs: distantBoundaryMs + 1000}],
    }]};
    view.setLyrics(instance._lyricsDocument);
    instance._updateIndicatorAndSchedule(true);
    instance._updateProgress();
    await Scripting.sleep(100);
    const distantWordSource = instance._wordTimerId;
    const distantPanelSource = view._panelLabelView._wordTimeoutId;
    assertBoundedSource(distantWordSource,
        'a distant lyric word must schedule a bounded native timeout');
    assertBoundedSource(distantPanelSource,
        'a distant panel word must schedule a bounded native timeout');
    instance._stopWordTimer();
    view._panelLabelView.cancel();
    assert(!GLib.MainContext.default().find_source_by_id(distantWordSource) &&
        !GLib.MainContext.default().find_source_by_id(distantPanelSource),
    'distant word and panel sources must remain cancellable');

    const longWordEndMs = 30_000_000_000;
    instance._lyricsDocument = {...offsetDocument, syncLevel: 'word', lines: [{
        lineId: 'long-word', text: panningText, startMs: 0, endMs: longWordEndMs,
        words: [{text: panningText, startMs: 0, endMs: longWordEndMs}],
    }]};
    view.setLyrics(instance._lyricsDocument);
    instance._updateIndicatorAndSchedule(true);
    await Scripting.sleep(100);
    const longWordPan = view._panelLabelView._panState(view._panelLabelView._positionAt());
    const longWordTransition = view._panelLabelView._panLabel.get_transition('translation-x');
    assert(longWordPan?.durationMs > 4_294_967_295 && longWordTransition &&
        longWordTransition.get_duration() <= 2_147_483_647 &&
        longWordTransition.get_duration() > 0 &&
        longWordTransition.get_delay() <= 2_147_483_647,
    'a word spanning beyond guint duration must retain a bounded native pan transition');
    instance._stopWordTimer();
    view._panelLabelView.cancel();
    assert(!view._panelLabelView._panLabel.get_transition('translation-x') &&
        view._panelLabelView._wordTimeoutId === 0,
    'cancelling a long word must remove its native transition and panel timeout');
    // The ordinary fixture below restores its document, track and playing state.
    fakePositionUs = 1_750_000;

    instance._state = {
        playbackStatus: 'Playing',
        playbackRate: 1,
        metadata: offsetMetadata,
    };
    instance._lyricsDocument = wordDocument;
    view.setTrack(offsetMetadata);
    view.setLyrics(wordDocument);
    instance._updateIndicatorAndSchedule(true);
    assert(instance._wordTimerId !== 0 && view._panelLabelView._label.text === markupText &&
        view._panelLabelView._scrollable &&
        view._panelLabelView._timeline?.startMs === 0 &&
        view._panelLabelView._timeline?.endMs === 3000 &&
        view._panelLabelView._timeline?.positionMs === 1750 &&
        view._panelLabelView._timeline?.playbackRate === 1 &&
        view._panelLabelView._words === wordDocument.lines[0].words,
        'a synchronized line should arm its word timer and panel timeline');
    const savedRateState = instance._state;
    const savedRatePosition = fakePositionUs;
    const savedDelay = instance._mprisManager.getDelayUntilPositionUs;
    const rateLine = {...wordDocument.lines[0], text: panningText, endMs: 10_000,
        words: [{text: panningText, startMs: 0, endMs: 10_000}]};
    try {
        instance._mprisManager.getDelayUntilPositionUs = targetUs =>
            instance._state.playbackStatus === 'Playing'
                ? Math.max(0, (targetUs - fakePositionUs) / 1000 / instance._state.playbackRate)
                : null;
        for (const syncLevel of ['line', 'word']) {
            instance._lyricsDocument = {...wordDocument, syncLevel, lines: [rateLine]};
            view.setLyrics(instance._lyricsDocument);
            fakePositionUs = 2_500_000;
            instance._updateIndicatorAndSchedule(true);
            await Scripting.sleep(100);
            for (const rate of [0.75, 1.25, 1.5, 2]) {
                instance._state = {...savedRateState, playbackStatus: 'Playing', playbackRate: rate};
                instance._updateIndicatorAndSchedule(true);
                const playingPan = view._panelLabelView._panState(2500);
                assert(view._panelLabelView._timeline?.playbackRate === rate && playingPan,
                    `${syncLevel}: panel timing must use the explicit player rate`);
                instance._state = {...instance._state, playbackStatus: 'Paused'};
                instance._updateIndicatorAndSchedule(true);
                const pausedPan = view._panelLabelView._panState(2500);
                assert(view._panelLabelView._timeline.playbackRate === rate &&
                    Math.abs(pausedPan.initialX - playingPan.initialX) < 0.001,
                `${syncLevel}: pausing at non-default speed must preserve the horizontal position`);
                instance._state = {...instance._state, playbackStatus: 'Playing'};
                instance._updateIndicatorAndSchedule(true);
                assert(view._panelLabelView._timeline.playbackRate === rate,
                    `${syncLevel}: resuming must retain the same timing rate`);
            }
        }
        instance._lyricsDocument = {...wordDocument, syncLevel: 'line', lines: [rateLine]};
        view.setLyrics(instance._lyricsDocument);
        instance._state = {...savedRateState, playbackRate: 2};
        fakePositionUs = 9_999_000;
        let delayReads = 0;
        instance._mprisManager.getDelayUntilPositionUs = () => {
            delayReads++;
            return 0.001;
        };
        instance._updateIndicatorAndSchedule(true);
        const nearEndTimeline = {...view._panelLabelView._timeline};
        for (let repeat = 0; repeat < 3; repeat++)
            instance._updateIndicatorAndSchedule(true);
        assert(nearEndTimeline.playbackRate === 2 &&
            panelTimelinesEqual(nearEndTimeline, view._panelLabelView._timeline) && delayReads === 0,
        'near-ending resynchronization must not infer rate from a later clock/delay sample');
    } finally {
        instance._mprisManager.getDelayUntilPositionUs = savedDelay;
        instance._state = savedRateState;
        instance._lyricsDocument = wordDocument;
        fakePositionUs = savedRatePosition;
        view.setLyrics(wordDocument);
        instance._updateIndicatorAndSchedule(true);
    }
    const originalPanelLanguage = instance._panelLyricsLanguage;
    const originalPanelTranslation = instance._translationLines;
    instance._panelLyricsLanguage = 'translated';
    instance._translationLines = new Map([[wordDocument.lines[0].lineId,
        'Translated word-synchronized lyric']]);
    instance._updateIndicatorAndSchedule(true);
    assert(view._panelLabelView._label.text === 'Translated word-synchronized lyric' &&
        view._panelLabelView._words === null,
        'the extension must not attach original word timing to translated panel text');
    instance._panelLyricsLanguage = originalPanelLanguage;
    instance._translationLines = originalPanelTranslation;
    instance._updateIndicatorAndSchedule(true);
    fakePositionUs = 2_250_000;
    instance._updateWordAndSchedule();
    assert(view._panelLabelView._label.text === markupText,
        'word changes must not update the top-bar label');
    indicator.menu.close();
    assert(instance._wordTimerId === 0 && instance._progressTimerId === 0,
        'closing the popup should stop word and progress timers immediately');
    indicator.menu.open();
    assert(instance._wordTimerId !== 0 && instance._progressTimerId !== 0,
        'opening the popup should re-arm word and progress updates');

    fakePositionUs = 1_750_000;
    view.setTrack(offsetMetadata);
    view.setLyrics(offsetDocument);
    instance._state = {
        playbackStatus: 'Paused',
        metadata: offsetMetadata,
    };
    instance._lyricsDocument = offsetDocument;
    instance._updateIndicatorAndSchedule(true);
    assert(instance._wordTimerId === 0 &&
        view._panelLabelView._timeline?.startMs === 1000 &&
        view._panelLabelView._timeline?.endMs === 2000 &&
        view._panelLabelView._timeline?.positionMs === 1750,
        'pause should cancel the word timer and preserve the lyric-time anchor');
    for (const [endMs, words, nextStartMs, expectedEndMs] of [
        [4000, [], 25000, 4000],
        [30000, [], 25000, 25000],
        [null, [{text: 'First', startMs: 1000, endMs: 4000}], 25000, 4000],
        [null, [{text: 'Fir', startMs: 1000, endMs: 4000},
            {text: 'st', startMs: 2000, endMs: null}], 25000, 25000],
        [null, [{text: 'Fir', startMs: 1000, endMs: 5000},
            {text: 'st', startMs: 2000, endMs: 4000}], 25000, 5000],
        [4000, [], null, 4000],
        [null, [], 25000, 25000],
        [null, [], null, 180000],
    ]) {
        const lines = [{...offsetLines[0], endMs, words}];
        if (nextStartMs !== null)
            lines.push({...offsetLines[1], startMs: nextStartMs});
        const timingDocument = {...offsetDocument, lines};
        instance._lyricsDocument = timingDocument;
        view.setLyrics(timingDocument);
        instance._updateIndicatorAndSchedule(true);
        assert(view._panelLabelView._timeline?.endMs === expectedEndMs,
            'panel timing must honor explicit ends, cap overlaps, and retain untimed fallbacks');
    }
    instance._lyricsDocument = offsetDocument;
    view.setLyrics(offsetDocument);
    instance._updateIndicatorAndSchedule(true);
    const offsetRows = [...view._lyricRows];
    instance._updateIndicatorAndSchedule(true);
    assert(instance._currentLyricIndex === 0,
        'the paused position should select the first lyric');
    view._increaseButton.emit('clicked', 1);
    assert(instance._trackOffsetMs === 500 &&
        view._offsetLabel.text === uiText('+0.5 s', '+0.5 秒') &&
        view._resetButton.visible,
        'popup buttons should adjust the current track offset');
    assert(instance._currentLyricIndex === 1 &&
        view._panelLabelView._label.text === 'Second',
        'a positive track offset should immediately advance the paused lyric');
    instance._setTrackOffsetMs(-1000);
    assert(instance._currentLyricIndex === -1,
        'a negative offset should immediately move before the first lyric');
    instance._setTrackOffsetMs(100_000);
    assert(instance._trackOffsetMs === 10_000,
        'a track offset should clamp to +10 seconds');
    view._resetButton.emit('clicked', 1);
    assert(instance._currentLyricIndex === 0 &&
        view._resetButton.visible && !view._resetButton.reactive &&
        view._lyricRows.every((row, index) => row === offsetRows[index]),
        'offset reset should dim in place and reuse the lyric row objects');

    instance._setTrackOffsetMs(1000);
    const secondMetadata = {...offsetMetadata, title: 'Offset Test B'};
    instance._state.metadata = secondMetadata;
    instance._trackOffsetMs = instance._offsetStore.get(secondMetadata);
    assert(instance._trackOffsetMs === 0,
        'track B should keep an independent zero offset');
    instance._state.metadata = offsetMetadata;
    instance._trackOffsetMs = instance._offsetStore.get(offsetMetadata);
    assert(instance._trackOffsetMs === 1000,
        'returning to track A should restore its offset');
    instance._setTrackOffsetMs(0);

    settings.set_int('global-offset-ms', 500);
    assert(instance._globalOffsetMs === 500 &&
        instance._currentLyricIndex === 1 &&
        view._effectiveOffsetLabel.text.includes(
            uiText('Effective +0.5 s', '实际 +0.5 秒', '實際 +0.5 秒')),
    'a GSettings global offset change should immediately resynchronize');
    settings.set_int('global-offset-ms', 0);

    settings.set_boolean('show-icon', false);
    assert(view._panelLabelView._label.text === 'First' && !view._icon.visible &&
        view._panelLabelView.actor.get_style().includes('500px'),
    'show-icon should hide only the symbolic icon and release its width');
    settings.set_boolean('show-icon', true);
    assert(view._panelLabelView._label.text === 'First' && view._icon.visible &&
        view._panelLabelView.actor.get_style().includes('478px'),
    'show-icon should restore the symbolic icon without changing lyric text');

    settings.set_boolean('word-sync-enabled', false);
    assert(!instance._wordSyncEnabled && instance._wordTimerId === 0,
        'disabling word sync should immediately stop its boundary timer');
    settings.set_boolean('word-sync-enabled', true);

    view.setLyrics(offsetDocument);
    instance._lyricsDocument = offsetDocument;
    instance._currentTrackKey = 'offset-test-key';
    settings.set_boolean('translation-enabled', true);
    await Scripting.sleep(50);
    assert(translationRequests === 1 &&
        view._translationLabels[0].text === '[zh-CN] First' &&
        view._translationLabels[0].visible,
    'enabling translation should apply line-aligned bilingual text without rebuilding rows');
    settings.set_string('panel-lyrics-language', 'translated');
    assert(view._panelLabelView._label.text === '[zh-CN] First',
        'the panel should use a loaded translation when requested');
    settings.set_string('translation-display-mode', 'translated');
    assert(!view._lyricLabels[0].visible &&
        instance._wordTimerId === 0,
    'translated-only popup mode should not run original word updates');
    settings.set_string('translation-display-mode', 'bilingual');
    view._translationActionButton.emit('clicked', 1);
    await Scripting.sleep(50);
    assert(translationRequests === 2 && translationForceRequests[1] === true,
        'the popup Refresh action should issue one forced translation request');
    // A failed Refresh while an existing translation is displayed must keep
    // forceRefresh: true when the user clicks Retry.
    view.setTranslationState('network_error');
    view._translationActionButton.emit('clicked', 1);
    await Scripting.sleep(50);
    assert(translationRequests === 3 && translationForceRequests[2] === true,
        'retrying a failed Refresh must bypass the stale cache');
    // Same-language state must offer an explicit manual override.
    view.setTranslation(null);
    view.setTranslationState('same_language');
    assert(view._translationActionButton.visible && view._translationActionButton.reactive &&
        view._translationActionButton.label === uiText('Translate anyway', '仍要翻译', '仍要翻譯'),
    'same-language status must expose a manual Translate anyway action');
    view._translationActionButton.emit('clicked', 1);
    await Scripting.sleep(50);
    assert(translationRequests === 4 && translationIgnoreSameRequests[3] === true,
        'Translate anyway must pass ignoreSameLanguage to override automatic skip');
    settings.set_int('translation-cache-clear-generation', 1);
    await Scripting.sleep(50);
    assert(translationCacheClears === 1 && translationRequests === 5,
        'translation cache clearing should remain separate and reload automatically');
    const mockTranslationService = instance._translationService;
    const translationStateSetter = view.setTranslationState;
    let releaseTranslationRead;
    let finishJoinedTranslation;
    let joinedProviderRequests = 0;
    let joinedLoadingUpdates = 0;
    const translationReadBlocked = new Promise(resolve => (releaseTranslationRead = resolve));
    const joinedService = new realTranslationService.constructor({
        providers: [{id: settings.get_string('translation-provider'), model: 'joined-fixture',
            requiresCredential: false,
            translate(_document, {chunk}) {
                joinedProviderRequests++;
                return new Promise(resolve => {
                    finishJoinedTranslation = () => resolve(chunk.lines.map(line => ({
                        lineId: line.id, text: `Joined ${line.text}`,
                    })));
                });
            }}],
        cache: {
            async get() {
                await translationReadBlocked;
                return {hit: false};
            },
            async put() {},
            destroy() {},
        },
    });
    try {
        instance._translationService = joinedService;
        view.setTranslationState = function (...args) {
            if (args[0] === 'loading')
                joinedLoadingUpdates++;
            return translationStateSetter.apply(this, args);
        };
        instance._clearTranslation();
        instance._requestTranslation({allowNetwork: true});
        assert(view._translationStatus === 'idle' && view._translationActionButton.reactive,
            'an initial cache read must leave the manual Translate action available');
        const pendingGeneration = instance._translationGeneration;
        view._translationActionButton.emit('clicked', 1);
        assert(instance._translationGeneration === pendingGeneration + 1,
            'the popup action must create a new subscriber generation while the cache read is pending');
        releaseTranslationRead();
        await Scripting.sleep(50);
        assert(joinedProviderRequests === 1 && joinedLoadingUpdates === 1 &&
            view._translationStatus === 'loading' && !view._translationActionButton.reactive,
        'the current generation must receive Loading and disable the button after joining pending work');
        instance._requestTranslation({allowNetwork: true});
        assert(joinedLoadingUpdates === 2 && joinedProviderRequests === 1,
            'a generation joining an already loading job must receive its status immediately');
        finishJoinedTranslation();
        await Scripting.sleep(50);
        assert(view._translationStatus === 'available' && view._translationActionButton.reactive &&
            view._translationLabels[0].text === 'Joined First' && joinedProviderRequests === 1,
        'joined completion must update the current generation and re-enable its action');
    } finally {
        releaseTranslationRead();
        finishJoinedTranslation?.();
        instance._cancelTranslation();
        joinedService.destroy();
        instance._translationService = mockTranslationService;
        view.setTranslationState = translationStateSetter;
    }
    settings.set_string('panel-lyrics-language', 'original');
    settings.set_boolean('translation-enabled', false);
    assert(!view._translationItem.visible && view._panelLabelView._label.text === 'First',
        'disabling translation should restore exact Phase 4 panel behavior');

    settings.set_int('max-panel-width', 640);
    assert(view._panelBox.get_style().includes('640px') &&
        view._panelBox.natural_width === 640 &&
        view._panelLabelView.actor.get_style().includes('618px'),
        'maximum panel width above 320px should expand the lyric viewport immediately');
    settings.set_int('max-panel-width', 200);
    assert(view._panelBox.get_style().includes('200px') &&
        view._panelBox.natural_width === 200 &&
        view._panelLabelView.actor.get_style().includes('178px'),
        'a configured maximum below the default width should cap both widths');
    settings.set_int('max-panel-width', 500);

    const reducedMotionSettings = St.Settings.get();
    const reducedMotionTitle = view._titleLabel.text;
    // This view-only playback test must not be overwritten by the paused
    // player's independent popup progress updates.
    const reducedMotionProgressWasRunning = Boolean(instance._progressTimerId);
    instance._stopProgressTimer();
    reducedMotionSettings.inhibit_animations();
    assert(!view._animationsEnabled(),
        'native Shell animation inhibition must reach the view');
    view.updateMetadataDisplay({title: 'Reduced motion title '.repeat(8),
        artist: view._artistLabel.text, album: view._albumLabel.text});
    view.setText('Reduced motion');
    view.setProgress(10_000_000, 220_000_000, {playing: true});
    view.setProgress(10_010_000, 220_000_000, {playing: true});
    const pagedText = `${panningText} and still more trailing words to span three timed pages`;
    view.setText(pagedText, {
        scrollable: true,
        timeline: panelTimeline(5000),
    });
    assert(view._panelLabelView._label.opacity === 255 &&
        !view._progressView._slider.get_transition('value') &&
        !view._panelLabelView._panLabel.get_transition('translation-x') &&
        !view._panelLabelView._fadeEffect.enabled &&
        !view._titleLabel.get_transition('translation-x'),
    'animation inhibition must stop movement before deferred layout completes');
    // Width and title changes can require several native layout frames.
    const reducedMotionDeadlineUs = GLib.get_monotonic_time() + 1_000_000;
    while ((view._panelLabelView._panLaterId || view._panelLabelView._geometryLaterId ||
        view._titlePanLaterId || !view._panelLabelView._panLabel.visible) &&
        GLib.get_monotonic_time() < reducedMotionDeadlineUs)
        await Scripting.sleep(20);
    assert(view._panelLabelView._label.opacity === 255 && !view._progressView._slider.get_transition('value') &&
        view._panelLabelView._panLaterId === 0 && view._panelLabelView._geometryLaterId === 0 &&
        view._titlePanLaterId === 0 &&
        !view._panelLabelView._label.visible && view._panelLabelView._panLabel.visible &&
        !view._panelLabelView._panLabel.get_transition('translation-x') &&
        view._panelLabelView._label.clutter_text.get_ellipsize() === Pango.EllipsizeMode.NONE &&
        view._panelLabelView._wordTimeoutId !== 0 &&
        !view._panelLabelView._fadeEffect.enabled &&
        !view._titleLabel.get_transition('translation-x'),
    'disabled Shell animations should use timed pages without animated movement ' +
        `(panLater=${view._panelLabelView._panLaterId}, geometryLater=${view._panelLabelView._geometryLaterId}, ` +
        `titleLater=${view._titlePanLaterId}, panVisible=${view._panelLabelView._panLabel.visible}, ` +
        `pageTimer=${view._panelLabelView._wordTimeoutId})`);
    const firstPageX = view._panelLabelView._panLabel.translation_x;
    const firstPageDeadlineUs = GLib.MainContext.default()
        .find_source_by_id(view._panelLabelView._wordTimeoutId).get_ready_time() + 500_000;
    while (view._panelLabelView._panLabel.translation_x === firstPageX &&
        GLib.get_monotonic_time() < firstPageDeadlineUs)
        await Scripting.sleep(20);
    assert(view._panelLabelView._panLabel.translation_x < firstPageX &&
        !view._panelLabelView._panLabel.get_transition('translation-x'),
    'reduced-motion lyrics must advance to a later page using the playback clock');
    const pageHoverPopupWasOpen = indicator.menu.isOpen;
    indicator.menu.close();
    view._panelLabelView._hovered = true;
    view._panelLabelView.pause();
    const hoveredPageX = view._panelLabelView._panLabel.translation_x;
    await Scripting.sleep(80);
    assert(view._panelLabelView._wordTimeoutId === 0 &&
        view._panelLabelView._panLabel.translation_x === hoveredPageX,
    'hovering must freeze the reduced-motion page and cancel its boundary timer');
    view.setText(pagedText, {scrollable: true, timeline: panelTimeline(5000, 4900)});
    await Scripting.sleep(80);
    assert(view._panelLabelView._panLabel.translation_x === hoveredPageX && view._panelLabelView._paused &&
        view._panelLabelView._wordTimeoutId === 0,
    'background resynchronization must not advance a hovered reduced-motion page');
    view.setText(pagedText, {scrollable: true, timeline: panelTimeline(5000, 2000)});
    view._panelLabelView._hovered = false;
    view._panelLabelView.resume();
    await Scripting.sleep(80);
    assert(view._panelLabelView._wordTimeoutId !== 0,
        'leaving hover must resume page scheduling from the playback clock');
    if (pageHoverPopupWasOpen) {
        indicator.menu.open();
        view.setProgress(10_010_000, 220_000_000, {playing: true});
    }
    view.setText(pagedText, {scrollable: true, timeline: panelTimeline(5000, 4900)});
    await Scripting.sleep(80);
    const finalPageX = view._panelLabelView._panLabel.translation_x;
    assert(finalPageX < hoveredPageX && view._panelLabelView._wordTimeoutId === 0,
        'seeking to the line ending must show its last page without a pending timer');
    view.setText(pagedText, {scrollable: true, timeline: panelTimeline(5000, 1000)});
    await Scripting.sleep(80);
    assert(view._panelLabelView._panLabel.translation_x > finalPageX &&
        view._panelLabelView._wordTimeoutId !== 0,
    'seeking backward must restore the earlier page and its next boundary');
    view.setProgress(10_010_000, 220_000_000, {playing: false});
    const pausedPageX = view._panelLabelView._panLabel.translation_x;
    await Scripting.sleep(80);
    assert(view._panelLabelView._wordTimeoutId === 0 &&
        view._panelLabelView._panLabel.translation_x === pausedPageX,
    'pausing must cancel the page boundary timer and keep the page still');
    view.setProgress(10_010_000, 220_000_000, {playing: true});
    reducedMotionSettings.uninhibit_animations();
    await Scripting.sleep(80);
    assert(view._animationsEnabled() && view._panelLabelView._wordTimeoutId === 0 &&
        view._panelLabelView._panLabel.get_transition('translation-x'),
    'restoring native animations must replace the page timer with continuous movement');
    if (St.ReducedMotion) {
        const motionSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
        const originalMotion = motionSettings.get_string('reduced-motion');
        const nativeReducedArtwork = new ArtworkView({loader: raceLoader});
        Main.uiGroup.add_child(nativeReducedArtwork.actor);
        try {
            motionSettings.set_string('reduced-motion', 'reduce');
            await Scripting.sleep(80);
            assert(reducedMotionSettings.enable_animations && !view._animationsEnabled() &&
                !view._panelLabelView._panLabel.get_transition('translation-x') &&
                view._panelLabelView._wordTimeoutId !== 0 &&
                !view._titleLabel.get_transition('translation-x') &&
                !view._titleCopy.visible && !view._panelLabelView._fadeEffect.enabled,
            'Shell 51 reduced motion must stop active title/lyric movement while animations stay enabled');
            const reducedPageX = view._panelLabelView._panLabel.translation_x;
            await Scripting.sleep(1700);
            assert(view._panelLabelView._panLabel.translation_x < reducedPageX &&
                !view._panelLabelView._panLabel.get_transition('translation-x'),
            'Shell 51 reduced motion must advance timed lyric pages');
            nativeReducedArtwork.setArtwork('file:///fast/b', 'native-reduced-a');
            await Scripting.sleep(80);
            nativeReducedArtwork.setArtwork('file:///fast/b', 'native-reduced-b');
            await Scripting.sleep(80);
            assert(nativeReducedArtwork._displayedTrackKey === 'native-reduced-b' &&
                !nativeReducedArtwork._outgoingTextureActor &&
                !nativeReducedArtwork._textureActor.get_transition('opacity'),
            'the native reduced-motion preference must replace artwork without a crossfade');
        } finally {
            nativeReducedArtwork.destroy();
            motionSettings.set_string('reduced-motion', originalMotion);
        }
        await Scripting.sleep(80);
        assert(view._animationsEnabled() && view._panelLabelView._wordTimeoutId === 0 &&
            view._panelLabelView._panLabel.get_transition('translation-x'),
        'clearing Shell 51 reduced motion must restore continuous lyric movement');
    }
    view.updateMetadataDisplay({title: reducedMotionTitle,
        artist: view._artistLabel.text, album: view._albumLabel.text});
    view.setText('First');
    if (reducedMotionProgressWasRunning)
        instance._startProgressTimer();

    settings.set_boolean('hide-when-paused', true);
    assert(!indicator.visible,
        'hide-when-paused should immediately hide a paused track');
    const savedPlaybackStatus = instance._state.playbackStatus;
    instance._state = {...instance._state, playbackStatus: 'Stopped'};
    instance._updateIndicatorAndSchedule(true);
    assert(!indicator.visible,
        'hide-when-paused should also hide a stopped track');
    instance._state = {...instance._state, playbackStatus: savedPlaybackStatus};
    settings.set_boolean('hide-when-paused', false);
    assert(indicator.visible,
        'disabling hide-when-paused should immediately restore the item');

    // Multiline merged LRC lines must flatten cleanly in the single-line top bar.
    const prevDoc = instance._lyricsDocument;
    instance._lyricsDocument = {
        ...offsetDocument,
        lines: [{lineId: 'bilingual-0', startMs: 0, endMs: 5000, words: [],
            text: 'Original line\nTranslated line'}],
    };
    instance._updateIndicatorAndSchedule(true);
    assert(view._panelLabelView._label.text === 'Original line  Translated line',
        'multiline merged lyrics must flatten newlines for the single-line panel');
    instance._lyricsDocument = prevDoc;
    instance._updateIndicatorAndSchedule(true);

    // RTL synchronized lyrics must start at the right end (-distance) and pan rightward.
    const rtlSample = 'مرحبا بالعالم هذه أغنية عربية طويلة جدا لاختبار اتجاه التمرير الصحيح '.repeat(3);
    view.setProgress(0, 220_000_000, {playing: false});
    view.setText(rtlSample, {
        scrollable: true,
        timeline: panelTimeline(8000, 0),
        contentKey: 'rtl-pan-check',
    });
    await Scripting.sleep(150);
    const rtlStartState = view._panelLabelView._panState(0);
    const rtlEndState = view._panelLabelView._panState(8000);
    assert(rtlStartState && rtlEndState &&
        rtlStartState.initialX < 0 && rtlStartState.targetX === 0 &&
        rtlEndState.initialX === 0,
    'RTL synchronized panel lyrics must start at the right edge and pan rightward to zero');
    view.setText('First');

    view.setPlayers(availablePlayers, 'auto');
    assert(view._playerMenu.menu.numMenuItems === 3 &&
        view._playerMenu.label.clutter_text.get_text() ===
            uiText('Player   Firefox', '播放器   Firefox'),
    'the popup should list Auto and only currently available stable players');
    view._playerMenu.menu._getMenuItems()[1].activate(null);
    assert(settings.get_string('preferred-player') === 'desktop:firefox' &&
        appliedPreference === 'desktop:firefox',
    'selecting a popup player should update GSettings and backend policy');
    settings.set_string('preferred-player', 'auto');

    settings.set_int('cache-clear-generation', 1);
    await Scripting.sleep(50);
    assert(runtimeCacheClears === 1,
        'cache generation changes should clear the running L1/L2 instance');

    instance._lyricsDocument = null;
    instance._lyricsLoaded = true;
    view.setLyrics(null);
    instance._updateIndicatorAndSchedule(true);
    assert(indicator.visible && view._panelLabelView._label.text === 'Offset Test' &&
        view._panelLabelView._looping && !view._panelLabelView._timeline,
        'no-lyrics fallback should show the title in loop mode without fake lyric timing');
    settings.set_boolean('fallback-track-info', false);
    assert(indicator.visible && !view._panelLabelView._label.text && view._icon.visible &&
        !view._panelLabelView.actor.visible,
        'no lyrics and no fallback should retain an icon-only media entry');
    settings.set_boolean('show-icon', false);
    assert(view._icon.visible,
        'disabling the normal icon must not remove an icon-only media entry');
    settings.set_boolean('show-icon', true);
    settings.set_boolean('fallback-track-info', true);
    assert(indicator.visible,
        're-enabling fallback information should restore the indicator');

    await Scripting.waitTestWindows();
    await Scripting.sleep(150);
    const panelTitleMeasure = view._panelLabelView._panLabel.clutter_text.get_layout().copy();
    panelTitleMeasure.set_ellipsize(Pango.EllipsizeMode.NONE);
    panelTitleMeasure.set_width(-1);
    let panelLoopTitle = 'Loop title ';
    do {
        panelLoopTitle += 'i';
        panelTitleMeasure.set_text(panelLoopTitle, -1);
    } while (panelTitleMeasure.get_pixel_size()[0] /
        view._panelLabelView._panLabel.clutter_text.get_resource_scale() <= view._panelLabelView._viewportWidth);
    instance._state = {playbackStatus: 'Playing',
        metadata: {...offsetMetadata, title: panelLoopTitle}};
    view.setProgress(fakePositionUs, offsetMetadata.durationUs, {playing: true});
    instance._updateIndicatorAndSchedule(true);
    await Scripting.sleep(150);
    assert(view._panelLabelView._panLabel.translation_x === 0 &&
        view._panelLabelView._fadeEffect.enabled && view._panelLabelView._fadeEffect._edges[1] === 0 &&
        view._panelLabelView._fadeEffect._edges[2] === 1,
    'the initial title hold must fade only the overflowing right edge');
    view.setProgress(fakePositionUs, offsetMetadata.durationUs, {playing: false});
    await Scripting.sleep(80);
    assert(view._panelLabelView._panLabel.translation_x === 0 && view._panelLabelView._fadeEffect._edges[1] === 0,
        'pausing a title at its start must preserve the complete first glyph');
    view.setProgress(fakePositionUs, offsetMetadata.durationUs, {playing: true});
    await Scripting.sleep(2150);
    const panelTitlePeriod = referenceLabelWidth(view._panelLabelView._panLabel) + 32;
    assert(view._panelLabelView._label.text === panelLoopTitle && view._panelLabelView._looping &&
        !view._panelLabelView._timeline && view._panelLabelView._wordTimeoutId === 0 &&
        view._panelLabelView._panLabel.translation_x < 0 && view._panelLabelView._titleCopy.visible,
    'a missing-lyrics title should scroll left without a lyric boundary timer');
    assert(view._panelLabelView._fadeEffect._edges[1] > 0 && view._panelLabelView._fadeEffect._edges[2] === 1,
        'a moving title loop must fade its clipped left edge and the incoming copy on the right');

    const instrumentalDocument = {source: 'test-instrumental', sourceId: null,
        instrumental: true, metadata: {}, syncLevel: 'none', lines: []};
    instance._lyricsDocument = instrumentalDocument;
    view.setLyrics(instrumentalDocument);
    instance._updateIndicatorAndSchedule(true);
    assert(view._panelLabelView._label.text === panelLoopTitle && view._panelLabelView._looping &&
        view._messageLabel.text === uiText('Instrumental', '纯音乐', '純音樂'),
    'an instrumental provider flag must loop the track title while retaining the popup explanation');
    assert(view._panelLabelView._targetX === -panelTitlePeriod,
        'the title loop must target one full title and gap, never a reverse leg');
    instance._state.playbackStatus = 'Paused';
    view.setProgress(fakePositionUs, offsetMetadata.durationUs, {playing: false});
    const pausedTitleX = view._panelLabelView._panLabel.translation_x;
    await Scripting.sleep(80);
    assert(view._panelLabelView._paused && view._panelLabelView._panLabel.translation_x === pausedTitleX &&
        !view._panelLabelView._panLabel.get_transition('translation-x'),
    'pause must freeze the title copies at their current position');
    instance._state.playbackStatus = 'Playing';
    view.setProgress(fakePositionUs, offsetMetadata.durationUs, {playing: true});
    assert(view._panelLabelView._panLabel.translation_x === pausedTitleX,
        'resuming a title loop must not jump back to its beginning');
    await checkTitleWrap(view._panelLabelView._panLabel, view._panelLabelView._titleCopy, panelTitlePeriod,
        () => view._panelLabelView._continueTitlePan());
    await Scripting.sleep(200);
    assert(view._panelLabelView._panLabel.translation_x < 0 &&
        view._panelLabelView._panLabel.get_transition('translation-x'),
    'the no-lyrics title must start another loop rather than stop after one pass');
    const panelLoopPopupWasOpen = indicator.menu.isOpen;
    indicator.menu.close();
    view._panelLabelView._hovered = true;
    view._panelLabelView.pause();
    const hoveredTitleX = view._panelLabelView._panLabel.translation_x;
    await Scripting.sleep(80);
    assert(view._panelLabelView._panLabel.translation_x === hoveredTitleX && view._panelLabelView._paused,
        'hover must freeze a panel title loop');
    view._panelLabelView._queueRestart();
    await Scripting.sleep(80);
    assert(view._panelLabelView._panLabel.translation_x === hoveredTitleX && view._panelLabelView._paused &&
        !view._panelLabelView._panLabel.get_transition('translation-x'),
    'a queued layout restart must preserve the hovered title loop position');
    view._panelLabelView._hovered = false;
    view._panelLabelView.resume();
    assert(view._panelLabelView._panLabel.translation_x === hoveredTitleX &&
        view._panelLabelView._panLabel.get_transition('translation-x'),
    'leaving hover must resume the panel title without resetting its position');
    if (panelLoopPopupWasOpen)
        indicator.menu.open();

    const panelTitleStyle = view._panelLabelView._panLabel.get_style();
    view._panelLabelView._panLabel.set_style('font-size: 31px;');
    await Scripting.sleep(180);
    const resizedTitleWidth = referenceLabelWidth(view._panelLabelView._panLabel);
    assert(referenceLabelWidth(view._panelLabelView._titleCopy) === resizedTitleWidth &&
        view._panelLabelView._titleCopy.get_allocation_box().x1 === resizedTitleWidth + 32,
    'font changes must update both copies and their spacing before restarting');
    view._panelLabelView._panLabel.set_style(panelTitleStyle);
    await Scripting.sleep(180);

    settings.set_int('max-panel-width', 200);
    await Scripting.sleep(150);
    assert(view._panelLabelView._looping && view._panelLabelView._viewportWidth <= 178 &&
        view._panelLabelView._panLabel.get_transition('translation-x'),
    'title loops must restart using the new allocated text viewport');
    St.Settings.get().inhibit_animations();
    await Scripting.sleep(80);
    assert(view._panelLabelView._label.visible && !view._panelLabelView._panLabel.visible &&
        !view._panelLabelView._titleCopy.visible &&
        !view._titleCopy.visible && !view._titleLabel.get_transition('translation-x') &&
        view._panelLabelView._label.clutter_text.get_ellipsize() === Pango.EllipsizeMode.END &&
        !view._panelLabelView._panLabel.get_transition('translation-x'),
    'a no-lyrics title must remain statically ellipsized when animations are disabled');
    St.Settings.get().uninhibit_animations();
    settings.set_int('max-panel-width', 500);
    await Scripting.sleep(100);
    assert(view._panelLabelView._panLabel.get_transition('translation-x'),
        'restoring animations must restart the panel title loop');
    view.clearTrack();
    assert(!view._panelLabelView._looping && view._panelLabelView._panLaterId === 0 &&
        !view._panelLabelView._panLabel.get_transition('translation-x') && !view._panelLabelView._titleCopy.visible,
    'clearing a track must cancel both loop state and pending title motion');
    instance._state = {playbackStatus: 'Paused', metadata: offsetMetadata};
    view.setProgress(fakePositionUs, offsetMetadata.durationUs, {playing: false});
    instance._lyricsDocument = offsetDocument;
    view.setLyrics(offsetDocument);
    instance._updateIndicatorAndSchedule(true);
    assert(!view._panelLabelView._looping && view._panelLabelView._label.text === 'First',
        'returning to synchronized lyrics must cancel the old title loop');

    const plainDocument = {
        source: 'test-plain',
        sourceId: null,
        instrumental: false,
        metadata: {},
        syncLevel: 'none',
        lines: [{
            lineId: 'plain-0',
            text: 'Static lyrics',
            startMs: null,
            endMs: null,
            words: [],
        }],
    };
    instance._lyricsDocument = plainDocument;
    view.setLyrics(plainDocument);
    settings.set_boolean('fallback-track-info', false);
    assert(indicator.visible && instance._currentLyricIndex === -1 &&
        view._panelLabelView._label.text === 'Offset Test — Paused Artist' &&
        !view._panelLabelView._scrollable,
    'plain lyrics should keep a static popup entry without pretending to sync');
    settings.set_boolean('fallback-track-info', true);
    instance._lyricsDocument = null;

    view.setLyrics({
        source: 'test-instrumental',
        sourceId: null,
        instrumental: true,
        metadata: {},
        syncLevel: 'none',
        lines: [],
    });
    assert(view._messageLabel.text === uiText('Instrumental', '纯音乐', '純音樂'),
        'instrumental should use one restrained centered line');

    view.setTrack({
        title: 'No Lyrics Track',
        artist: 'Another Artist',
        album: '',
        artUrl: 'invalid://artwork',
        durationUs: 0,
    }, 'no-artwork-track');
    view.setLyrics(null);
    assert(view._lyricRows.length === 0 &&
        view._messageLabel.text === uiText('No lyrics found', '未找到歌词', '找不到歌詞'),
        'the popup should show the no-lyrics result');
    assert(!view._albumLabel.visible && view._albumLabel.text === '',
        'an absent album should stay hidden without artificial fallback text');
    assert(view._artworkView._fallback.visible,
        'invalid artwork should retain the symbolic fallback');
    view.setArtwork(Gio.File.new_for_path('/etc/hostname').get_uri(),
        'invalid-image-track');
    await Scripting.sleep(3200);
    assert(view._artworkView._fallback.visible &&
        !view._artworkView._textureActor,
    'a decode failure should time out to fallback without a broken image');
    assert(view._titleLabel.text === 'No Lyrics Track' &&
        view._artistLabel.text === 'Another Artist',
        'the no-lyrics state should retain title and artist');

    view.setLyrics({...lineDocument, source: 'lrcapi-synced'});
    assert(view._lyricsSourceItem.visible && view._lyricsSourceLabel.text.includes('LrcAPI'),
        'setting LrcAPI lyrics should display the source label');
    view.setTrack({
        title: 'Next Track',
        artist: 'Next Artist',
        album: '',
        artUrl: '',
        durationUs: 0,
    }, 'next-track-source-clear');
    assert(!view._lyricsSourceItem.visible && !view._lyricsSourceLabel.text,
        'switching tracks must hide the previous track lyrics source while loading');

    // Verify unknown duration (0) + positive offset does not invent a fake line end.
    instance._state = {
        busName: 'org.mpris.MediaPlayer2.test',
        playbackStatus: 'Paused',
        playbackRate: 1,
        positionUs: 2_000_000,
        metadata: {trackId: '', title: 'Stream', artist: 'Live', album: '', artUrl: '', durationUs: 0},
    };
    instance._lyricsDocument = {
        source: 'lrclib-synced',
        sourceId: null,
        instrumental: false,
        metadata: {},
        syncLevel: 'line',
        lines: [{lineId: 's0', text: 'Only line', startMs: 1000, endMs: null, words: []}],
    };
    instance._globalOffsetMs = 5000;
    instance._trackOffsetMs = 0;
    instance._updateIndicatorAndSchedule(true);
    assert(view._panelLabelView._timeline === null,
        'unknown track duration (0) plus positive offset must not fabricate a line end timeline');
    instance._globalOffsetMs = 0;

    // Verify cancelled slider drag restores progress on drag-end while paused.
    view.setProgress(30_000_000, 100_000_000, {playing: false});
    const progressSlider = view._progressView._slider;
    view._progressView.setControlState({busName: 'test', generation: 1, trackKey: 'k'}, true);
    progressSlider.emit('drag-begin');
    progressSlider.value = 0.8;
    view._progressView.cancelDrag();
    progressSlider.emit('drag-end');
    assert(Math.abs(progressSlider.value - 0.3) < 0.01 &&
        view._progressView._currentLabel.text === '0:30',
    'releasing a cancelled progress drag must restore the authoritative position');

    view.setLyrics({...lineDocument, source: 'lrcapi-synced'});
    view.clearTrack();
    assert(!view._lyricsSourceItem.visible && !view._lyricsSourceLabel.text,
        'clearing a track must clear its source label');

    instance._state = null;
    instance._lyricsDocument = null;
    instance._mprisManager = realMprisManager;
    instance._offsetStore = realOffsetStore;
    instance._lyricsProvider = realLyricsProvider;
    instance._translationService = realTranslationService;

    indicator.menu.close();

    const clearOnDisable = realLyricsProvider.clearCaches;
    let finishClearOnDisable;
    realLyricsProvider.clearCaches = () => new Promise(resolve => (finishClearOnDisable = resolve));
    settings.set_int('cache-clear-generation', settings.get_int('cache-clear-generation') + 1);
    assert(Main.extensionManager.disableExtension(UUID),
        'the extension could not be disabled');
    finishClearOnDisable();
    realLyricsProvider.clearCaches = clearOnDisable;

    await Scripting.sleep(500);
    assert(!Main.panel.statusArea[UUID],
        'disable() did not destroy the panel indicator');
    assert(instance._settings === null &&
        instance._settingsSignalIds.length === 0 &&
        instance._lineTimerId === 0 && instance._wordTimerId === 0 &&
        instance._progressTimerId === 0 &&
        instance._translationService === null,
    'disable() should disconnect settings and destroy timers/translation service');

    for (let cycle = 1; cycle <= 3; cycle++) {
        assert(Main.extensionManager.enableExtension(UUID),
            `enable cycle ${cycle} failed after cleanup`);
        await Scripting.sleep(300);
        const cycleIndicator = Main.panel.statusArea[UUID];
        const cycleView = Main.extensionManager.lookup(UUID)?.stateObj?._indicator;
        assert(cycleIndicator &&
            Main.panel.statusArea[UUID] === cycleIndicator,
        `enable cycle ${cycle} should create exactly one registered indicator`);
        if (cycle === 1) {
            cycleView.setVisible(true);
            cycleView._panelLabelView.setHovered(true);
            cycleIndicator.menu.open(false);
        }
        assert(Main.extensionManager.disableExtension(UUID),
            `disable cycle ${cycle} failed`);
        await Scripting.sleep(200);
        assert(!Main.panel.statusArea[UUID] && cycleView.actor === null &&
            cycleView._panelLabelView === null,
            `disable cycle ${cycle} left a stale indicator`);
    }
}

export function finish() {
    print('GNOME Shell bilingual popup, settings, timers and lifecycle test passed');
}
