import {
    comfortableScrollTarget,
    formatDuration,
    getLineVisualLevel,
    normalizePanelTimeline,
    panelPanState,
    panelTimelinesEqual,
    progressFraction,
} from '../ui-utils.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

assert(formatDuration(0) === '0:00', 'zero duration should be 0:00');
assert(formatDuration(5.9) === '0:05', 'seconds should be zero-padded');
assert(formatDuration(69) === '1:09', 'minutes should be formatted');
assert(formatDuration(3599) === '59:59', 'sub-hour duration should omit hours');
assert(formatDuration(3733) === '1:02:13', 'hours should include padded minutes');
assert(formatDuration(-1) === '0:00' && formatDuration(Number.NaN) === '0:00',
    'invalid duration should clamp to zero');

assert(progressFraction(30, 100) === 0.3,
    'progress should return a normal fraction');
assert(progressFraction(-10, 100) === 0 &&
    progressFraction(150, 100) === 1,
    'progress should clamp to the closed unit interval');
assert(progressFraction(10, 0) === 0 &&
    progressFraction(Number.NaN, 100) === 0,
    'invalid progress inputs should be safe');

const normalizedTimeline = normalizePanelTimeline({
    startMs: 0,
    endMs: 3000,
    positionMs: 0,
    playbackRate: 0,
});
assert(normalizedTimeline?.playbackRate === 1 &&
    normalizePanelTimeline({
        startMs: 1000,
        endMs: 1000,
        positionMs: 1000,
    }) === null,
'panel timelines should normalize playback rate and reject empty ranges');
assert(panelTimelinesEqual(normalizedTimeline, {...normalizedTimeline}) &&
    !panelTimelinesEqual(normalizedTimeline, {
        ...normalizedTimeline,
        positionMs: 1,
    }),
'panel timeline equality should include the playback anchor');

const fastPan = panelPanState(normalizedTimeline, 0, 429);
assert(fastPan.delayMs === 360 && fastPan.durationMs === 2040 &&
    Math.abs(fastPan.speedPxPerSecond - 210.294) < 0.01 &&
    fastPan.shouldAnimate,
'a three-second line should reserve 12% at the start and 20% at the end');
const seekPan = panelPanState({
    startMs: 0,
    endMs: 5000,
    positionMs: 3000,
    playbackRate: 1,
}, 3000, 429);
assert(Math.abs(seekPan.initialX - -429 * 2400 / 3400) < 0.01 &&
    seekPan.delayMs === 0 && seekPan.durationMs === 1000,
'a seek should map directly to its lyric-time horizontal position');
const finishedPan = panelPanState(normalizedTimeline, 2500, 429);
assert(finishedPan.initialX === -429 && !finishedPan.shouldAnimate,
'the lyric should remain at its end during the reserved tail hold');
const doubleRatePan = panelPanState({
    ...normalizedTimeline,
    playbackRate: 2,
}, 0, 429);
assert(doubleRatePan.delayMs === 0 && doubleRatePan.durationMs === 1500 &&
    doubleRatePan.targetX === -429 && doubleRatePan.speedPxPerSecond === 286,
'fast playback should use all available time when the reference speed is unattainable');
const protectedPan = panelPanState(normalizedTimeline, 0, 600);
assert(Math.abs(protectedPan.delayMs - 188) <= 1 &&
    protectedPan.durationMs === 2500 && protectedPan.speedPxPerSecond === 240,
'a fast line should proportionally shorten its holds to reach the reference speed');
const protectedSeek = panelPanState(normalizedTimeline, 1200, 600);
assert(Math.abs(protectedSeek.initialX + (1200 - 187.5) * 0.24) < 0.01 &&
    protectedSeek.delayMs === 0,
'seeking into a protected line should use the same adjusted timeline');
const protectedEnd = panelPanState(normalizedTimeline, 2700, 600);
assert(protectedEnd.initialX === -600 && !protectedEnd.shouldAnimate,
'a protected line should still reveal its full ending during its remaining hold');
const tinyPan = panelPanState(normalizedTimeline, 1500, 3);
assert(tinyPan.initialX === -1.5 && tinyPan.targetX === -3 &&
    tinyPan.delayMs === 0 && tinyPan.durationMs === 1500 &&
    tinyPan.speedPxPerSecond === 1,
'a tiny overflow should move gently across the full line without extra holds');
const tinyEnd = panelPanState(normalizedTimeline, 3000, 3);
assert(tinyEnd.initialX === -3 && !tinyEnd.shouldAnimate,
'a tiny overflow must still reveal every pixel of the ending');
assert(panelPanState(normalizedTimeline, 2700, 3).shouldAnimate,
'resuming or seeking near a tiny overflow ending should still finish the last fraction of a pixel');
assert(panelPanState(null, 0, 429) === null &&
    panelPanState(normalizedTimeline, 0, 0) === null,
'invalid panel pan inputs should remain static');

assert(getLineVisualLevel(5, 5).name === 'current' &&
    getLineVisualLevel(4, 5).opacity === 184 &&
    getLineVisualLevel(3, 5).opacity === 143 &&
    getLineVisualLevel(1, 5).opacity === 107,
'line focus should decrease through current, near, mid, and far levels');
assert(getLineVisualLevel(5, -1).name === 'static',
    'plain or not-yet-active lyrics should keep a readable static level');

assert(comfortableScrollTarget({
    rowTop: 140,
    rowBottom: 160,
    value: 50,
    lower: 0,
    upper: 500,
    pageSize: 200,
}) === null, 'a line inside the comfortable zone should not scroll');
assert(comfortableScrollTarget({
    rowTop: 260,
    rowBottom: 280,
    value: 50,
    lower: 0,
    upper: 500,
    pageSize: 200,
}) === 176, 'a line outside the comfortable zone should return near 47%');
assert(comfortableScrollTarget({
    rowTop: 10,
    rowBottom: 30,
    value: 0,
    lower: 0,
    upper: 500,
    pageSize: 200,
    force: true,
}) === 0, 'forced positioning should clamp at the beginning');

print('UI duration, progress, panel pan and lyric layout tests passed');
