import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MprisManager} from '../mpris.js';

const BUS_NAME = 'org.mpris.MediaPlayer2.EventTest';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_INTERFACE = 'org.freedesktop.DBus';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES_INTERFACE = 'org.freedesktop.DBus.Properties';

const rootInterfaceXml = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const playerInterfaceXml = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <property name="CanControl" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
  </interface>
</node>`;

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function sleep(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function waitUntil(predicate, message) {
    for (let attempt = 0; attempt < 40; attempt++) {
        if (predicate())
            return;
        await sleep(50);
    }
    throw new Error(message);
}

function metadata(title, durationUs = 180_000_000, artUrl = '') {
    const value = {
        'mpris:trackid': new GLib.Variant(
            'o', '/org/mpris/MediaPlayer2/event_test'),
        'xesam:title': new GLib.Variant('s', title),
        'xesam:artist': new GLib.Variant('as', ['Event Artist']),
        'xesam:album': new GLib.Variant('s', 'Event Album'),
        'mpris:length': new GLib.Variant('x', durationUs),
    };
    if (artUrl)
        value['mpris:artUrl'] = new GLib.Variant('s', artUrl);
    return value;
}

const connection = Gio.DBus.session;
let playbackStatus = 'Paused';
let currentMetadata = metadata('Initial Track');
let positionUs = 10_000_000;
let positionGets = 0;
let canSeek = true;
let failNext = false;
let holdNext = false;
let nextInvocation = null;
let holdPlay = false;
let playInvocation = null;
let holdSeek = false;
let seekInvocation = null;
let onPositionGet = null;
const commands = [];

const implementation = {
    get CanControl() { return true; },
    get CanPlay() { return true; },
    get CanPause() { return true; },
    get CanGoNext() { return true; },
    get CanGoPrevious() { return true; },
    get CanSeek() { return canSeek; },
    PlayAsync(_parameters, invocation) {
        commands.push('Play');
        playbackStatus = 'Playing';
        if (holdPlay) {
            playInvocation = invocation;
            return;
        }
        propertiesChanged({PlaybackStatus: new GLib.Variant('s', playbackStatus)});
        invocation.return_value(new GLib.Variant('()', []));
    },
    Pause() {
        commands.push('Pause');
        playbackStatus = 'Paused';
        propertiesChanged({PlaybackStatus: new GLib.Variant('s', playbackStatus)});
    },
    NextAsync(_parameters, invocation) {
        commands.push('Next');
        if (failNext)
            invocation.return_dbus_error('org.mpris.MediaPlayer2.Error.Failed',
                'Test playback failure');
        else if (holdNext)
            nextInvocation = invocation;
        else
            invocation.return_value(new GLib.Variant('()', []));
    },
    Previous() { commands.push('Previous'); },
    SetPositionAsync([trackId, position], invocation) {
        commands.push([trackId, position]);
        if (holdSeek) {
            seekInvocation = invocation;
            return;
        }
        seeked(position);
        invocation.return_value(new GLib.Variant('()', []));
    },
    get Identity() {
        return 'Event Test Player';
    },

    get DesktopEntry() {
        return 'event-test';
    },

    get PlaybackStatus() {
        return playbackStatus;
    },

    // Firefox reports zero while paused. The manager must still use a
    // one-timescale local clock after PlaybackStatus changes to Playing.
    get Rate() {
        return 0;
    },

    get Metadata() {
        return currentMetadata;
    },

    get Position() {
        positionGets++;
        const snapshot = positionUs;
        onPositionGet?.();
        return snapshot;
    },
};

const exportedRoot = Gio.DBusExportedObject.wrapJSObject(
    rootInterfaceXml, implementation);
const exportedPlayer = Gio.DBusExportedObject.wrapJSObject(
    playerInterfaceXml, implementation);
exportedRoot.export(connection, MPRIS_PATH);
exportedPlayer.export(connection, MPRIS_PATH);

function requestName() {
    connection.call_sync(
        DBUS_NAME,
        DBUS_PATH,
        DBUS_INTERFACE,
        'RequestName',
        new GLib.Variant('(su)', [BUS_NAME, 0]),
        new GLib.VariantType('(u)'),
        Gio.DBusCallFlags.NONE,
        1000,
        null);
}

function releaseName() {
    connection.call_sync(
        DBUS_NAME,
        DBUS_PATH,
        DBUS_INTERFACE,
        'ReleaseName',
        new GLib.Variant('(s)', [BUS_NAME]),
        new GLib.VariantType('(u)'),
        Gio.DBusCallFlags.NONE,
        1000,
        null);
}

function propertiesChanged(changed, invalidated = []) {
    connection.emit_signal(
        null,
        MPRIS_PATH,
        PROPERTIES_INTERFACE,
        'PropertiesChanged',
        new GLib.Variant('(sa{sv}as)', [
            PLAYER_INTERFACE,
            changed,
            invalidated,
        ]));
}

function seeked(newPositionUs) {
    positionUs = newPositionUs;
    connection.emit_signal(
        null,
        MPRIS_PATH,
        PLAYER_INTERFACE,
        'Seeked',
        new GLib.Variant('(x)', [newPositionUs]));
}

const loop = new GLib.MainLoop(null, false);
let state = null;
let callbackCount = 0;
let players = [];
let scenarioError = null;
let manager = new MprisManager(nextState => {
    state = nextState;
    callbackCount++;
}, {
    onPlayersChanged: nextPlayers => (players = nextPlayers),
});
manager.start();

async function run() {
    await sleep(100);
    requestName();
    await waitUntil(
        () => state?.metadata.title === 'Initial Track',
        'NameOwnerChanged did not discover the new player');
    assert(state.playbackStatus === 'Paused',
        'the initial paused state was not loaded');
    assert(positionGets === 1,
        'initial discovery should read Position exactly once via GetAll');
    await waitUntil(
        () => players[0]?.stableId === 'desktop:event-test',
        'the root MPRIS identity was not exposed as a stable descriptor');

    const beforeResumeGets = positionGets;
    playbackStatus = 'Playing';
    propertiesChanged({
        PlaybackStatus: new GLib.Variant('s', playbackStatus),
    });
    await waitUntil(
        () => state?.playbackStatus === 'Playing' &&
            positionGets === beforeResumeGets + 1,
        'resume did not perform one Position recalibration');

    const playingStartUs = manager.getPositionUs();
    await sleep(650);
    const playingEndUs = manager.getPositionUs();
    assert(playingEndUs - playingStartUs > 500_000,
        'the monotonic clock did not advance while playing with Rate=0');
    assert(positionGets === beforeResumeGets + 1,
        'stable playback performed unexpected Position polling');

    positionUs = Math.round(playingEndUs);
    const beforePauseGets = positionGets;
    playbackStatus = 'Paused';
    propertiesChanged({
        PlaybackStatus: new GLib.Variant('s', playbackStatus),
    });
    await waitUntil(
        () => state?.playbackStatus === 'Paused' &&
            positionGets === beforePauseGets + 1,
        'pause did not perform one Position recalibration');
    const pausedStartUs = manager.getPositionUs();
    await sleep(300);
    assert(Math.abs(manager.getPositionUs() - pausedStartUs) < 1_000,
        'the local clock did not freeze while paused');
    assert(positionGets === beforePauseGets + 1,
        'the paused state performed unexpected Position polling');

    const beforeSeekGets = positionGets;
    seeked(90_000_000);
    await waitUntil(
        () => Math.abs(manager.getPositionUs() - 90_000_000) < 1_000,
        'the forward Seeked signal did not set the anchor');
    seeked(30_000_000);
    await waitUntil(
        () => Math.abs(manager.getPositionUs() - 30_000_000) < 1_000,
        'the backward Seeked signal did not set the anchor');
    assert(positionGets === beforeSeekGets,
        'Seeked should not cause an extra Position Get');

    const beforeArtworkGets = positionGets;
    currentMetadata = metadata(
        'Initial Track', 180_000_000, 'file:///tmp/event-cover.png');
    propertiesChanged({
        Metadata: new GLib.Variant('a{sv}', currentMetadata),
    });
    await waitUntil(
        () => state?.metadata.artUrl === 'file:///tmp/event-cover.png',
        'an artUrl-only metadata change was not emitted');
    assert(positionGets === beforeArtworkGets,
        'an artUrl-only change should not recalibrate playback Position');

    const beforeMetadataGets = positionGets;
    currentMetadata = metadata('Replacement Track');
    positionUs = 0;
    propertiesChanged({
        Metadata: new GLib.Variant('a{sv}', currentMetadata),
    });
    await waitUntil(
        () => state?.metadata.title === 'Replacement Track' &&
            positionGets === beforeMetadataGets + 1,
        'Metadata change did not update the track and recalibrate Position');

    const target = state.controlTarget;
    assert(state.capabilities.CanControl && state.capabilities.CanSeek,
        'initial MPRIS capabilities were not loaded');
    assert(await manager.control('Play', target), 'Play was not dispatched');
    await waitUntil(() => state.playbackStatus === 'Playing', 'Play feedback missing');
    assert(await manager.control('Pause', target), 'Pause was not dispatched');
    await waitUntil(() => state.playbackStatus === 'Paused', 'Pause feedback missing');
    let beforeRefresh = callbackCount;
    assert(await manager.control('Previous', target), 'Previous was not dispatched');
    await waitUntil(() => callbackCount > beforeRefresh,
        'Previous without a signal was not reconciled');
    beforeRefresh = callbackCount;
    assert(await manager.control('Next', target), 'Next was not dispatched');
    await waitUntil(() => callbackCount > beforeRefresh,
        'Next without a signal was not reconciled');
    const beforeControlSeekGets = positionGets;
    assert(await manager.control('SetPosition', target, 55_000_000),
        'SetPosition was not dispatched');
    await waitUntil(() => manager.getPositionUs() === 55_000_000,
        'SetPosition feedback did not synchronize the playback clock');
    assert(commands.at(-1)[0] === '/org/mpris/MediaPlayer2/event_test' &&
        commands.at(-1)[1] === 55_000_000,
        'SetPosition must include the current object-path track ID and microseconds');
    // Gio may dispatch the method reply before the queued Seeked callback.
    // In that case one reconciliation read is allowed, never repeated polling.
    await sleep(100);
    assert(positionGets <= beforeControlSeekGets + 1,
        'a control seek performed more than one reconciliation query');
    const settledSeekGets = positionGets;
    await sleep(100);
    assert(positionGets === settledSeekGets,
        'a completed control seek started Position polling');
    holdSeek = true;
    const beforeHeldSeekGets = positionGets;
    const heldSeek = manager.control('SetPosition', target, 65_000_000);
    await waitUntil(() => seekInvocation !== null, 'delayed seek was not dispatched');
    canSeek = false;
    propertiesChanged({CanSeek: new GLib.Variant('b', false)});
    await waitUntil(() => !state.capabilities.CanSeek,
        'capability notification during seek was not received');
    propertiesChanged({Position: new GLib.Variant('x', 65_000_000)});
    await waitUntil(() => manager.getPositionUs() === 65_000_000,
        'explicit position feedback during the pending seek was not received');
    propertiesChanged({}, ['Position', 'CanSeek']);
    await waitUntil(() => positionGets === beforeHeldSeekGets + 1,
        'capability invalidation did not refresh while the seek was pending');
    await sleep(30);
    assert(manager.getPositionUs() === 55_000_000,
        'the pending seek fixture must still expose the old position before completion');
    onPositionGet = () => {
        onPositionGet = null;
        canSeek = true;
        propertiesChanged({CanSeek: new GLib.Variant('b', true),
            Volume: new GLib.Variant('d', 0.5)});
    };
    positionUs = 65_000_000;
    seekInvocation.return_value(new GLib.Variant('()', []));
    seekInvocation = null;
    assert(await heldSeek, 'a seek accepted before capabilities changed must complete');
    await waitUntil(() => manager.getPositionUs() === 65_000_000,
        'unrelated notifications suppressed seek reconciliation or discarded its Position reply');
    await sleep(100);
    assert(positionGets === beforeHeldSeekGets + 2 && state.capabilities.CanSeek,
        'a silent seek must reconcile once after completion despite an earlier refresh');
    holdSeek = false;

    holdPlay = true;
    const heldPlay = manager.control('Play', target);
    await waitUntil(() => playInvocation !== null, 'delayed play was not dispatched');
    canSeek = false;
    propertiesChanged({CanSeek: new GLib.Variant('b', false)});
    await waitUntil(() => !state.capabilities.CanSeek,
        'capability notification during play was not received');
    propertiesChanged({PlaybackStatus: new GLib.Variant('s', 'Paused')});
    await waitUntil(() => state.playbackStatus === 'Paused',
        'opposite status notification during Play was not received');
    onPositionGet = () => {
        onPositionGet = null;
        canSeek = true;
        propertiesChanged({CanSeek: new GLib.Variant('b', true),
            Volume: new GLib.Variant('d', 0.6)});
    };
    playInvocation.return_value(new GLib.Variant('()', []));
    playInvocation = null;
    assert(await heldPlay, 'silent Play was rejected');
    await waitUntil(() => state.playbackStatus === 'Playing',
        'an unrelated capability notification suppressed silent Play reconciliation');
    assert(state.capabilities.CanSeek,
        'an older full snapshot overwrote a newer capability notification');
    holdPlay = false;
    assert(await manager.control('Pause', target), 'pause after silent Play failed');
    await waitUntil(() => state.playbackStatus === 'Paused', 'pause feedback missing');
    canSeek = true;
    propertiesChanged({CanSeek: new GLib.Variant('b', true)});
    await waitUntil(() => state.capabilities.CanSeek, 'seek capability restoration failed');

    onPositionGet = () => {
        onPositionGet = null;
        seeked(75_000_000);
    };
    propertiesChanged({PlaybackStatus: new GLib.Variant('s', 'Paused')});
    await waitUntil(() => manager.getPositionUs() === 75_000_000,
        'new Seeked feedback did not supersede the older pending Position reply');
    await sleep(100);
    assert(manager.getPositionUs() === 75_000_000,
        'an older Position reply overwrote a newer Seeked anchor');
    assert(await manager.control('SetPosition', target, -1),
        'negative progress must clamp to the beginning');
    assert(commands.at(-1)[1] === 0, 'progress was not clamped to zero');
    assert(await manager.control('SetPosition', target, 999_000_000),
        'progress past the duration must clamp');
    assert(commands.at(-1)[1] === 180_000_000, 'progress exceeded track duration');
    const beforeRejected = commands.length;
    assert(!await manager.control('SetPosition', target, NaN), 'NaN seek was accepted');
    assert(!await manager.control('Stop', target), 'unsupported action was accepted');
    assert(!await manager.control('Play', {...target, generation: -1}),
        'a target from another player instance was accepted');
    assert(!await manager.control('SetPosition', {...target, trackKey: 'old track'}, 1),
        'a drag targeting an old track was accepted');
    canSeek = false;
    propertiesChanged({CanSeek: new GLib.Variant('b', false)});
    await waitUntil(() => !state.capabilities.CanSeek, 'CanSeek update missing');
    assert(!await manager.control('SetPosition', target, 1),
        'a player without seeking support received a seek');
    assert(commands.length === beforeRejected, 'rejected commands reached D-Bus');
    canSeek = true;
    propertiesChanged({CanSeek: new GLib.Variant('b', true)});
    await waitUntil(() => state.capabilities.CanSeek, 'CanSeek restoration missing');
    failNext = true;
    let rejected = false;
    try {
        await manager.control('Next', target);
    } catch (error) {
        rejected = error.message.includes('Test playback failure');
    }
    assert(rejected, 'D-Bus control failures must remain observable');
    failNext = false;

    holdNext = true;
    let pending = manager.control('Next', state.controlTarget).then(
        () => false, error => error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    await waitUntil(() => nextInvocation !== null, 'delayed control did not start');
    currentMetadata = metadata('Changed During Control');
    propertiesChanged({Metadata: new GLib.Variant('a{sv}', currentMetadata)});
    await waitUntil(() => state?.metadata.title === 'Changed During Control',
        'same-ID track replacement was not observed');
    assert(await pending, 'changing tracks must cancel pending control calls');
    nextInvocation.return_value(new GLib.Variant('()', []));
    nextInvocation = null;
    currentMetadata = metadata('Replacement Track');
    propertiesChanged({Metadata: new GLib.Variant('a{sv}', currentMetadata)});
    await waitUntil(() => state?.metadata.title === 'Replacement Track',
        'replacement track restoration failed');
    pending = manager.control('Next', state.controlTarget).then(
        () => false, error => error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    await waitUntil(() => nextInvocation !== null, 'second delayed control did not start');
    releaseName();
    assert(await pending, 'player removal must cancel pending control calls');
    nextInvocation.return_value(new GLib.Variant('()', []));
    nextInvocation = null;
    holdNext = false;
    await waitUntil(
        () => state === null,
        'NameOwnerChanged did not remove the vanished player');

    requestName();
    await waitUntil(
        () => state?.metadata.title === 'Replacement Track',
        'NameOwnerChanged did not rediscover the returning player');
    assert(!await manager.control('Play', target),
        'a command for the vanished player instance reached its replacement');
    releaseName();
    await waitUntil(
        () => state === null,
        'the returning player was not removed cleanly');

    manager.destroy();
    manager = null;
    requestName();
    manager = new MprisManager(nextState => {
        state = nextState;
        callbackCount++;
    });
    state = null;
    manager.start();
    await waitUntil(() => state?.capabilities.CanControl,
        'initial ListNames discovery did not resolve the unique owner');
    holdNext = true;
    pending = manager.control('Next', state.controlTarget).then(
        () => false, error => error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    await waitUntil(() => nextInvocation !== null, 'destroy test control did not start');
    manager.destroy();
    manager = null;
    assert(await pending, 'destroy must cancel pending media control calls');
    nextInvocation.return_value(new GLib.Variant('()', []));
    nextInvocation = null;
    holdNext = false;
    releaseName();
    const callbacksAfterDestroy = callbackCount;
    requestName();
    await sleep(200);
    assert(callbackCount === callbacksAfterDestroy,
        'destroy() left a NameOwnerChanged subscription active');
    releaseName();
}

run()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

manager?.destroy();
try {
    releaseName();
} catch {
    // The name may already have been released by the successful scenario.
}
exportedRoot.unexport();
exportedPlayer.unexport();

if (scenarioError)
    throw scenarioError;

print('MPRIS event, monotonic clock, no-polling and cleanup tests passed');
