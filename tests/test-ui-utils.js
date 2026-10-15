import {
    comfortableScrollTarget,
    formatDuration,
    getLineVisualLevel,
    normalizePanelTimeline,
    panelPanState,
    panelTimelinesEqual,
    progressFraction,
    wordPanState,
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
assert(doubleRatePan.delayMs === 0 && doubleRatePan.durationMs === 1300 &&
    doubleRatePan.targetX === -429 && doubleRatePan.speedPxPerSecond === 330,
'fast playback should preserve a real ending hold even when the reference speed is unattainable');
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
assert(Math.abs(tinyPan.initialX + 3 * 1500 / 2800) < 0.01 && tinyPan.targetX === -3 &&
    tinyPan.delayMs === 0 && tinyPan.durationMs === 1300 &&
    Math.abs(tinyPan.speedPxPerSecond - 3 / 2.8) < 0.01,
'a tiny overflow should move gently and still reserve time to display its ending');
const tinyEnd = panelPanState(normalizedTimeline, 3000, 3);
assert(tinyEnd.initialX === -3 && !tinyEnd.shouldAnimate,
'a tiny overflow must still reveal every pixel of the ending');
assert(panelPanState(normalizedTimeline, 2700, 3).shouldAnimate,
'resuming or seeking near a tiny overflow ending should still finish the last fraction of a pixel');
for (const duration of [120, 240, 500, 1000]) {
    const endPosition = duration - Math.min(200, duration * 0.25);
    const state = panelPanState({startMs: 0, endMs: duration, positionMs: 0,
        playbackRate: 1}, endPosition, 1500);
    assert(state.initialX === -1500 && !state.shouldAnimate,
        'even a short fast line must finish before its next-line replacement');
}
const longHold = panelPanState({startMs: 43530, endMs: 54440,
    positionMs: 49000, playbackRate: 1}, 49000, 51);
assert(longHold.initialX === -51 && !longHold.shouldAnimate,
    'line-only sustained notes should reveal the ending after a four-second reading pass');
const closeToYouTiny = panelPanState({startMs: 43530, endMs: 54440,
    positionMs: 49000, playbackRate: 1}, 49000, 5);
assert(closeToYouTiny.initialX === -5 && !closeToYouTiny.shouldAnimate,
    'Close To You must also reveal a small clipped ending within four seconds');
assert(panelPanState(null, 0, 429) === null &&
    panelPanState(normalizedTimeline, 0, 0) === null,
'invalid panel pan inputs should remain static');

const measuredWords = [
    {startMs: 0, endMs: 1000, startX: 0, endX: 200},
    {startMs: 1500, endMs: 2500, startX: 200, endX: 400},
];
const focusedPan = wordPanState(normalizedTimeline, 750, measuredWords, 100, 308);
assert(focusedPan.initialX === -90 && focusedPan.targetX === -140 &&
    focusedPan.durationMs === 250 && focusedPan.nextMs === 1000,
'word focus should interpolate actual geometry at sixty percent of the viewport');
const focusLead = wordPanState(normalizedTimeline, 0, measuredWords, 100, 308);
assert(focusLead.initialX === 0 && focusLead.delayMs === 300 &&
    focusLead.durationMs === 700,
'word motion should wait until the current text reaches the focus');
const focusGap = wordPanState(normalizedTimeline, 1200, measuredWords, 100, 308);
assert(focusGap.initialX === -140 && !focusGap.shouldAnimate && focusGap.nextMs === 1500,
'an explicit gap between words should hold the preceding word position');
const focusTail = wordPanState(normalizedTimeline, 2400, measuredWords, 100, 308);
assert(focusTail.initialX === -308 && !focusTail.shouldAnimate,
'word focus should stop at the full ending rather than scroll beyond it');
const rateFocus = wordPanState({...normalizedTimeline, playbackRate: 2},
    750, measuredWords, 100, 308);
assert(rateFocus.durationMs === 125,
'word segments should honor playback rate');
const finalWord = [{startMs: 0, endMs: 3000, startX: 0, endX: 2000}];
const wordEndingHold = wordPanState(normalizedTimeline, 2800, finalWord, 100, 1908);
assert(wordEndingHold.initialX === -1908 && !wordEndingHold.shouldAnimate,
    'the final word must also expose the ending before next-line replacement');
assert(wordPanState(normalizedTimeline, 2900,
    [{startMs: 2900, endMs: 3000, startX: 0, endX: 2000}], 100, 1908) === null,
    'a final word too short to reserve an ending window should use line motion');
assert(wordPanState(normalizedTimeline, 0, null, 100, 308) === null &&
    wordPanState(normalizedTimeline, NaN, measuredWords, 100, 308) === null &&
    wordPanState(normalizedTimeline, 0, measuredWords, 10, 308) === null,
'missing geometry and impractically narrow viewports should fall back to line motion');

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

const pageTimeline = {startMs: 1000, endMs: 11000, positionMs: 1000, playbackRate: 1};
let pagePosition = pageTimeline.startMs;
let previousPageX = 0;
let pages = 0;
while (pages < 10) {
    const page = panelPanState(pageTimeline, pagePosition, 500, 160);
    assert(!page.shouldAnimate && page.targetX === page.initialX &&
        page.initialX <= previousPageX && previousPageX - page.initialX <= 160,
    'reduced-motion pages must overlap and move only forward without animation');
    previousPageX = page.initialX;
    pages++;
    if (page.nextMs === null)
        break;
    assert(page.nextMs > pagePosition && page.nextMs < pageTimeline.endMs,
        'each page must have a future playback boundary before the line ends');
    pagePosition = page.nextMs + 0.01;
}
assert(pages === 5 && previousPageX === -500,
    'timed pages must expose the complete ending and stop scheduling');
assert(panelPanState({...pageTimeline, playbackRate: 2}, 1000, 500, 160).nextMs > 1000 &&
    panelPanState(pageTimeline, 12000, 500, 160).initialX === -500,
    'page timing must support faster playback and seeks beyond the line end');

print('UI duration, progress, panel pan and lyric layout tests passed');
