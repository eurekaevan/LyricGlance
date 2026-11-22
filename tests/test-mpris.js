import GLib from 'gi://GLib';

import {MprisManager, parseMetadata} from '../mpris.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const metadata = new GLib.Variant('a{sv}', {
    'mpris:trackid': new GLib.Variant('o', '/org/mpris/MediaPlayer2/example'),
    'xesam:title': new GLib.Variant('s', ' Example Song '),
    'xesam:artist': new GLib.Variant('as', ['First Artist', 'Second Artist']),
    'xesam:album': new GLib.Variant('s', 'Example Album'),
    'mpris:artUrl': new GLib.Variant('s',
        'file:///home/test/.cache/player/cover.png'),
    'mpris:length': new GLib.Variant('x', 220_000_000),
});
const parsed = parseMetadata(metadata);

assert(parsed.trackId === '/org/mpris/MediaPlayer2/example',
    'track ID should be unpacked');
assert(parsed.title === 'Example Song', 'title should be unpacked and trimmed');
assert(parsed.artist === 'First Artist, Second Artist',
    'multiple artists should be joined');
assert(parsed.album === 'Example Album', 'album should be unpacked');
assert(parsed.artUrl === 'file:///home/test/.cache/player/cover.png',
    'artwork URL should be unpacked');
assert(parsed.durationUs === 220_000_000, 'duration should stay in microseconds');

const unstartedManager = new MprisManager(() => {});
unstartedManager._players.set('org.mpris.MediaPlayer2.malformed', {
    name: 'org.mpris.MediaPlayer2.malformed',
    owner: '',
    metadata: parsed,
    capabilities: {},
    propertyVersions: {},
    stateVersion: 0,
    positionRequestSerial: 0,
    anchorPositionUs: 0,
    anchorMonotonicUs: 0,
    playbackStatus: 'Stopped',
    rate: 1,
});
unstartedManager._onPropertiesChanged('org.mpris.MediaPlayer2.malformed',
    new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']));
unstartedManager._onSeeked('org.mpris.MediaPlayer2.malformed',
    new GLib.Variant('()', []));
const messyMetadata = parseMetadata({
    'xesam:title': 'Messy',
    'xesam:artist': ['Valid Artist', null, 42, {bad: true}, ' Second '],
});
assert(messyMetadata.artist === 'Valid Artist, Second',
    'non-string artist entries must be ignored instead of stringified');
unstartedManager.destroy();
unstartedManager.destroy();
assert(unstartedManager._cancellable === null && unstartedManager.getPlayers().length === 0,
    'destroy must be safe before start and on repeated calls');

print('MPRIS metadata and unstarted lifecycle tests passed');
