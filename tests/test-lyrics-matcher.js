import {MIN_CANDIDATE_SCORE, scoreLyricsCandidate} from '../lyrics-matcher.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const track = {
    title: 'Example Song - 2011 Remastered',
    artist: 'Example Artist',
    album: 'Original Album (Deluxe)',
    durationUs: 220_000_000,
};
const payload = {
    plainLyrics: 'Example',
    syncedLyrics: '[00:01.00]Example',
    lyricsfile: null,
    instrumental: false,
};

const albumVersion = scoreLyricsCandidate(track, {
    ...payload,
    id: 1,
    trackName: 'Example Song',
    artistName: 'Example Artist',
    albumName: 'Original Album',
    duration: 220.8,
});
assert(albumVersion.accepted && albumVersion.score >= MIN_CANDIDATE_SCORE &&
    albumVersion.diagnostics.durationDelta < 1,
'a close-duration remaster/album metadata variation should be accepted');

const liveVersion = scoreLyricsCandidate(track, {
    ...payload,
    id: 2,
    trackName: 'Example Song (Live)',
    artistName: 'Example Artist',
    albumName: 'Live in Somewhere',
    duration: 265,
});
assert(!liveVersion.accepted,
    'a duration-mismatched live version should be rejected');

const wrongArtist = scoreLyricsCandidate(track, {
    ...payload,
    id: 3,
    trackName: 'Example Song',
    artistName: 'Completely Different',
    albumName: 'Original Album',
    duration: 220,
});
assert(!wrongArtist.accepted,
    'a title match must not overcome an unrelated artist');

const emptyCandidate = scoreLyricsCandidate(track, {
    id: 4,
    trackName: track.title,
    artistName: track.artist,
    albumName: track.album,
    duration: 220,
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: null,
    lyricsfile: null,
});
assert(!emptyCandidate.accepted,
    'metadata confidence must not accept a candidate with no usable lyrics');

const cjkYearCandidate = scoreLyricsCandidate({
    title: '晴天 (2003)',
    artist: '周杰伦',
    album: '叶惠美',
    durationUs: 269_000_000,
}, {
    ...payload,
    provider: 'lrcapi',
    trackName: '晴天',
    artistName: '周杰伦',
    albumName: '',
    duration: null,
});
assert(cjkYearCandidate.accepted && cjkYearCandidate.diagnostics.albumMatch === 0.5,
    'a CJK title with a year suffix and missing candidate album should remain matchable');

const driftedDuration = scoreLyricsCandidate(track, {
    ...payload,
    id: 5,
    trackName: 'Example Song',
    artistName: 'Example Artist',
    albumName: 'Original Album',
    duration: 227.5,
});
assert(!driftedDuration.accepted,
    'a candidate whose duration drifts more than 6 seconds should be rejected');

print('LRCLIB candidate scoring and confidence threshold tests passed');
