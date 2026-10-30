import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'lyric-glance@eureka';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function bounds(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
}

function ink(label) {
    const text = label.clutter_text;
    const [x, y] = text.get_transformed_position();
    const [rect] = text.get_layout().get_pixel_extents();
    const scale = text.get_resource_scale();
    return {x: x + rect.x / scale, y: y + rect.y / scale,
        width: rect.width / scale, height: rect.height / scale};
}

function color(actor) {
    const value = actor.get_theme_node().get_foreground_color();
    return [value.red, value.green, value.blue, value.alpha];
}

function sameColor(first, second) {
    return first.every((value, index) => value === second[index]);
}

function assertFocusVisible(actor, scrollView) {
    const focus = bounds(actor);
    const viewport = bounds(scrollView);
    assert(global.stage.key_focus === actor &&
        focus.y >= viewport.y - 1 &&
        focus.y + focus.height <= viewport.y + viewport.height + 1,
    'keyboard focus must reveal the complete control inside the outer viewport');
}

async function checkPresentation(view, scale, theme) {
    view.actor.menu.open();
    view.setCurrentLyricIndex(20, {reposition: true});
    await Scripting.sleep(500);

    const normal = color(view.actor.menu.box);
    assert(sameColor(color(view._lyricLabels[20]), normal),
        'the active lyric must inherit the normal menu foreground');
    assert(sameColor(color(view._artistLabel), normal) &&
        sameColor(color(view._offsetLabel), normal),
    'passive metadata and timing text must inherit the normal foreground');
    const metadata = [view._titleLabel, view._artistLabel, view._albumLabel].map(ink);
    const controlsTop = Math.min(...[...view._mediaButtons.values()]
        .map(button => bounds(button).y));
    for (let index = 0; index < metadata.length; index++) {
        const text = metadata[index];
        const nextTop = metadata[index + 1]?.y ?? controlsTop;
        assert(text.height > 0 && text.y + text.height <= nextTop + 1,
            'title, artist and album must remain separate above the transport controls ' +
                JSON.stringify({theme, scale, index, metadata, controlsTop}));
    }
    view.setOffsets(0, 0);
    await Scripting.sleep(80);
    assert(!view._resetButton.reactive &&
        !sameColor(color(view._resetButton), normal),
    'the genuinely disabled reset control must retain its insensitive color');
    view.setOffsets(500, 0);
    await Scripting.sleep(80);
    assert(view._resetButton.reactive && sameColor(color(view._resetButton), normal),
        'reset must regain the normal foreground when enabled');

    const refresh = bounds(view._translationActionButton);
    const reset = bounds(view._resetButton);
    assert(Math.abs(refresh.x + refresh.width - reset.x - reset.width) <= 1,
        'refresh and reset must share their right edge');
    const playerNode = view._playerMenu.get_theme_node();
    const resourceScale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    assert(playerNode.get_padding(St.Side.LEFT) === 18 * resourceScale &&
        playerNode.get_padding(St.Side.RIGHT) === 18 * resourceScale,
    'the player selector must share the 18px content inset');

    const gaps = [15, 19, 20, 21, 24].map(index => {
        const original = ink(view._lyricLabels[index]);
        const translated = ink(view._translationLabels[index]);
        const next = ink(view._lyricLabels[index + 1]);
        const inside = translated.y - original.y - original.height;
        const between = next.y - translated.y - translated.height;
        assert(inside >= 0 && inside < between,
            `bilingual line ${index} must be closer to its own translation than the next line`);
        return {index, inside, between};
    });
    assert(view._scrollView.get_effect('fade'),
        'the native vertical fade must soften clipped lyric edges');

    const menu = bounds(view.actor.menu.actor);
    const workArea = Main.layoutManager.getWorkAreaForMonitor(
        Main.layoutManager.primaryIndex);
    assert(menu.x >= workArea.x - 1 &&
        menu.x + menu.width <= workArea.x + workArea.width + 1 &&
        menu.y >= workArea.y - 1 &&
        menu.y + menu.height <= workArea.y + workArea.height + 1,
    'the popup must fit the monitor work area');
    const lyrics = bounds(view._scrollView);
    const outer = bounds(view._menuScrollView);
    const visibleLyrics = Math.min(lyrics.y + lyrics.height, outer.y + outer.height) -
        Math.max(lyrics.y, outer.y);
    assert(visibleLyrics >= 80 * scale * resourceScale,
        'the lyric viewport must retain several readable lines on short displays');
    for (const label of [view._lyricLabels[20], view._translationLabels[20]]) {
        const text = ink(label);
        for (const viewport of [lyrics, outer]) {
            assert(text.y >= viewport.y - 1 &&
                text.y + text.height <= viewport.y + viewport.height + 1,
            `the active original and translation must remain visible after opening ` +
                `(${JSON.stringify({theme, scale, text, viewport})})`);
        }
    }

    const adjustment = view._menuScrollView.vadjustment;
    const overflow = adjustment.upper > adjustment.page_size + 1;
    for (const actor of [view._playerMenu, view._resetButton]) {
        global.stage.set_key_focus(null);
        adjustment.value = 0;
        await Scripting.sleep(80);
        const before = bounds(actor);
        const viewport = bounds(view._menuScrollView);
        const wasBelow = before.y + before.height > viewport.y + viewport.height + 1;
        actor.grab_key_focus();
        await Scripting.sleep(120);
        assertFocusVisible(actor, view._menuScrollView);
        if (wasBelow)
            assert(adjustment.value > 0, 'offscreen footer focus must scroll the menu');
    }
    const scrollValue = adjustment.value;
    view.actor.menu.close();
    global.stage.set_key_focus(view._playerMenu);
    await Scripting.sleep(100);
    assert(adjustment.value === scrollValue,
        'focus changes after closing must not scroll the hidden menu');
    global.stage.set_key_focus(null);
    print(`presentation=${JSON.stringify({theme, scale, menuHeight: menu.height,
        workHeight: workArea.height, lyricsHeight: view._scrollView.height, visibleLyrics,
        overflow, gaps})}`);
}

async function checkOffsetCenters(view) {
    const actors = [];
    const collect = actor => {
        actors.push([actor, actor.get_text_direction()]);
        for (const child of actor.get_children())
            collect(child);
    };
    collect(view.actor.menu.actor);
    const originals = [view._decreaseButton.label, view._offsetLabel.text,
        view._increaseButton.label];
    try {
        view.actor.menu.open();
        for (const [direction, unit] of [
            [Clutter.TextDirection.LTR, 's'], [Clutter.TextDirection.LTR, '秒'],
            [Clutter.TextDirection.RTL, 'ث'], [Clutter.TextDirection.RTL, 'שנ׳'],
        ]) {
            for (const [actor] of actors)
                actor.set_text_direction(direction);
            view._decreaseButton.label = `−0.5 ${unit}`;
            view._offsetLabel.text = `+0.5 ${unit}`;
            view._increaseButton.label = `+0.5 ${unit}`;
            await Scripting.sleep(180);
            const buttons = [bounds(view._decreaseButton), bounds(view._increaseButton)]
                .sort((first, second) => first.x - second.x);
            const value = ink(view._offsetLabel);
            const delta = value.x + value.width / 2 -
                (buttons[0].x + buttons[0].width + buttons[1].x) / 2;
            assert(Math.abs(delta) <= 1,
                `timing glyphs must be centered between the buttons (${unit}: ${delta}px)`);
            print(`offsetCenter=${JSON.stringify({unit, direction, delta})}`);
        }
    } finally {
        for (const [actor, direction] of actors)
            actor.set_text_direction(direction);
        [view._decreaseButton.label, view._offsetLabel.text,
            view._increaseButton.label] = originals;
        view.actor.menu.close();
    }
}

export async function run() {
    await Scripting.sleep(700);
    const view = Main.extensionManager.lookup(UUID)?.stateObj?._indicator;
    assert(view, 'the packaged extension must create its indicator');
    const document = {
        source: 'lrclib-synced', syncLevel: 'line', metadata: {}, instrumental: false,
        lines: Array.from({length: 30}, (_unused, index) => ({
            lineId: `line-${index}`, text: `Synchronized lyric line ${index + 1}`,
            startMs: index * 1000, endMs: null, words: [],
        })),
    };
    view.updateMetadataDisplay({title: 'A synthetic song title',
        artist: 'Synthetic artist', album: 'Synthetic album'});
    view.setLyrics(document);
    view.setTranslationEnabled(true);
    view.setTranslation({lines: document.lines.map((line, index) => ({
        lineId: line.lineId, text: `第 ${index + 1} 行译文`,
    }))});
    view.setTranslationState('available');
    view.setTranslationDisplayMode('bilingual');
    view.setPlayers([{stableId: 'test', displayName: 'Synthetic player', selected: true}], 'test');
    view.setMediaState({controlTarget: {busName: 'test', trackKey: 'test'},
        playbackStatus: 'Playing', metadata: {trackId: '/test', durationUs: 220_000_000},
        capabilities: {CanControl: true, CanPause: true, CanPlay: true,
            CanGoPrevious: true, CanGoNext: true, CanSeek: true}});
    view.setProgress(20_000_000, 220_000_000, {playing: true});
    view.setOffsets(500, 0);
    view.setText('Synthetic panel line');
    view.setVisible(true);

    const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const originalScale = settings.get_double('text-scaling-factor');
    const originalTheme = Main.getThemeStylesheet();
    const directory = GLib.dir_make_tmp('lyric-presentation-XXXXXX');
    const files = [];
    try {
        for (const theme of ['dark', 'light']) {
            const path = `${directory}/${theme}.css`;
            const bytes = Gio.resources_lookup_data(
                `/org/gnome/shell/theme/gnome-shell-${theme}.css`,
                Gio.ResourceLookupFlags.NONE);
            GLib.file_set_contents(path, bytes.get_data());
            files.push(path);
            Main.setThemeStylesheet(path);
            Main.loadTheme();
            for (const scale of [1, 1.5]) {
                settings.set_double('text-scaling-factor', scale);
                await Scripting.sleep(250);
                await checkPresentation(view, scale, theme);
                await checkOffsetCenters(view);
            }
        }
        view.actor.menu.open();
        view._playerMenu.grab_key_focus();
        assert(Main.extensionManager.disableExtension(UUID),
            'the focused popup must disable successfully');
        global.stage.set_key_focus(Main.panel._leftBox);
        await Scripting.sleep(200);
        assert(!Main.panel.statusArea[UUID],
            'disabling the focused popup must remove its indicator');
    } finally {
        settings.set_double('text-scaling-factor', originalScale);
        Main.setThemeStylesheet(originalTheme);
        Main.loadTheme();
        for (const path of files)
            GLib.unlink(path);
        GLib.rmdir(directory);
    }
}

export function finish() {
    print('GNOME Shell popup presentation test passed');
}
