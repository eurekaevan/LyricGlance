export function formatDuration(seconds) {
    const value = Number(seconds);
    const totalSeconds = Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:` +
            `${String(remainingSeconds).padStart(2, '0')}`;
    }

    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function progressFraction(positionUs, durationUs) {
    const position = Number(positionUs);
    const duration = Number(durationUs);
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0)
        return 0;

    return Math.min(1, Math.max(0, position / duration));
}

const PANEL_PAN_LEAD_FRACTION = 0.12;
const PANEL_PAN_END_HOLD_FRACTION = 0.20;
const PANEL_PAN_MAX_LEAD_MS = 600;
const PANEL_PAN_MAX_END_HOLD_MS = 1000;
const PANEL_PAN_REFERENCE_SPEED = 240;
const PANEL_PAN_SMALL_DISTANCE = 8;
const PANEL_PAN_MIN_END_HOLD_MS = 200;
const PANEL_PAN_MAX_MOTION_MS = 4000;

export function normalizePanelTimeline(timeline) {
    const startMs = timeline?.startMs;
    const endMs = timeline?.endMs;
    const positionMs = timeline?.positionMs;
    const playbackRate = timeline?.playbackRate;
    if (![startMs, endMs, positionMs].every(Number.isFinite) ||
        endMs <= startMs)
        return null;

    return {
        startMs,
        endMs,
        positionMs,
        playbackRate: Number.isFinite(playbackRate) && playbackRate > 0
            ? playbackRate
            : 1,
    };
}

export function panelTimelinesEqual(first, second) {
    if (!first || !second)
        return first === second;
    return first.startMs === second.startMs &&
        first.endMs === second.endMs &&
        first.positionMs === second.positionMs &&
        first.playbackRate === second.playbackRate;
}

export function panelPanState(timeline, positionMs, overflow, stepWidth = 0) {
    const normalized = normalizePanelTimeline(timeline);
    const position = Number(positionMs);
    const distance = Number(overflow);
    if (!normalized || !Number.isFinite(position) ||
        !Number.isFinite(distance) || distance <= 0)
        return null;

    const lineDurationMs = normalized.endMs - normalized.startMs;
    let leadMs = Math.min(
        PANEL_PAN_MAX_LEAD_MS,
        lineDurationMs * PANEL_PAN_LEAD_FRACTION);
    let endHoldMs = Math.min(
        PANEL_PAN_MAX_END_HOLD_MS,
        lineDurationMs * PANEL_PAN_END_HOLD_FRACTION);
    const minimumEndHoldMs = Math.min(
        PANEL_PAN_MIN_END_HOLD_MS * normalized.playbackRate, lineDurationMs * 0.25);
    if (distance <= PANEL_PAN_SMALL_DISTANCE) {
        // Move gently without an initial hold, but reveal even a tiny clipped
        // ending within the same reading window as larger overflows.
        leadMs = 0;
        endHoldMs = Math.max(minimumEndHoldMs,
            lineDurationMs - PANEL_PAN_MAX_MOTION_MS * normalized.playbackRate);
    } else {
        const holdMs = leadMs + endHoldMs;
        const requiredMotionMs = distance * normalized.playbackRate /
            PANEL_PAN_REFERENCE_SPEED * 1000;
        const motionMs = Math.min(lineDurationMs - minimumEndHoldMs,
            Math.max(requiredMotionMs, Math.min(lineDurationMs - holdMs,
                PANEL_PAN_MAX_MOTION_MS * normalized.playbackRate)));
        const availableHoldMs = lineDurationMs - motionMs;
        leadMs = Math.min(leadMs, holdMs > 0 ? availableHoldMs * leadMs / holdMs : 0);
        endHoldMs = availableHoldMs - leadMs;
        if (endHoldMs < minimumEndHoldMs) {
            endHoldMs = minimumEndHoldMs;
            leadMs = availableHoldMs - endHoldMs;
        }
    }
    const motionStartMs = normalized.startMs + leadMs;
    const motionEndMs = Math.max(
        motionStartMs, normalized.endMs - endHoldMs);
    const motionDurationMs = Math.max(1, motionEndMs - motionStartMs);
    const progress = Math.min(1, Math.max(0,
        (position - motionStartMs) / motionDurationMs));
    if (Number.isFinite(stepWidth) && stepWidth > 0) {
        // Overlap pages so the reader can keep their place, without any
        // animated movement. Give the last page its own reading interval.
        const steps = Math.ceil(distance / stepWidth);
        const page = Math.min(steps, Math.floor(progress * (steps + 1)));
        const initialX = -distance * page / steps;
        return {initialX, targetX: initialX, shouldAnimate: false,
            nextMs: page < steps
                ? motionStartMs + motionDurationMs * (page + 1) / (steps + 1)
                : null};
    }
    const initialX = -distance * progress;
    const targetX = -distance;
    const delayMs = Math.max(0, Math.round(
        (motionStartMs - position) / normalized.playbackRate));
    const durationMs = Math.max(1, Math.round(
        (motionEndMs - Math.max(position, motionStartMs)) /
        normalized.playbackRate));
    const remainingDistance = Math.abs(targetX - initialX);

    return {
        initialX,
        targetX,
        delayMs,
        durationMs,
        speedPxPerSecond: remainingDistance / durationMs * 1000,
        shouldAnimate: position < motionEndMs && remainingDistance > 0,
    };
}

// Geometry is measured once from the panel's Pango layout. Follow the current
// word linearly, stopping when its focus reaches either edge of the viewport.
export function wordPanState(timeline, positionMs, words, viewportWidth, distance) {
    const normalized = normalizePanelTimeline(timeline);
    if (!normalized || !Number.isFinite(positionMs) || !words?.length ||
        viewportWidth < 20 || !(distance > 0))
        return null;
    const focus = viewportWidth * 0.6;
    const minimumEndHoldMs = Math.min(
        PANEL_PAN_MIN_END_HOLD_MS * normalized.playbackRate,
        (normalized.endMs - normalized.startMs) * 0.25);
    const lastEndMs = Math.min(words.at(-1).endMs, normalized.endMs - minimumEndHoldMs);
    if (lastEndMs <= words.at(-1).startMs)
        return null;
    const offset = x => -Math.min(distance, Math.max(0, x - focus));
    for (const word of words) {
        const endMs = word === words.at(-1) ? lastEndMs : word.endMs;
        if (positionMs >= endMs)
            continue;
        if (positionMs < word.startMs) {
            return {initialX: offset(word.startX), targetX: offset(word.startX),
                shouldAnimate: false, nextMs: word.startMs};
        }
        const spanMs = endMs - word.startMs;
        const width = word.endX - word.startX;
        const initialX = offset(word.startX + width *
            (positionMs - word.startMs) / spanMs);
        const motionStartMs = word.startMs + Math.max(0,
            (focus - word.startX) / width) * spanMs;
        const motionEndMs = Math.min(endMs, word.startMs +
            (focus + distance - word.startX) / width * spanMs);
        const targetX = offset(word.endX);
        return {initialX, targetX,
            delayMs: Math.max(0, Math.round(
                (motionStartMs - positionMs) / normalized.playbackRate)),
            durationMs: Math.max(1, Math.round(
                (motionEndMs - Math.max(positionMs, motionStartMs)) /
                    normalized.playbackRate)),
            shouldAnimate: targetX < initialX,
            nextMs: endMs};
    }
    return {initialX: -distance, targetX: -distance, shouldAnimate: false};
}

const LINE_VISUAL_LEVELS = Object.freeze({
    static: Object.freeze({name: 'static', opacity: 224}),
    far: Object.freeze({name: 'far', opacity: 107}),
    mid: Object.freeze({name: 'mid', opacity: 143}),
    near: Object.freeze({name: 'near', opacity: 184}),
    current: Object.freeze({name: 'current', opacity: 255}),
});

export function getLineVisualLevel(index, currentIndex) {
    if (!Number.isInteger(index) || !Number.isInteger(currentIndex) ||
        currentIndex < 0)
        return LINE_VISUAL_LEVELS.static;

    const distance = Math.abs(index - currentIndex);
    if (distance === 0)
        return LINE_VISUAL_LEVELS.current;
    if (distance === 1)
        return LINE_VISUAL_LEVELS.near;
    if (distance === 2)
        return LINE_VISUAL_LEVELS.mid;
    return LINE_VISUAL_LEVELS.far;
}

export function comfortableScrollTarget({
    rowTop,
    rowBottom,
    value,
    lower,
    upper,
    pageSize,
    force = false,
}) {
    const values = [rowTop, rowBottom, value, lower, upper, pageSize];
    if (!values.every(Number.isFinite) || pageSize <= 0 || rowBottom < rowTop)
        return null;

    const maximum = Math.max(lower, upper - pageSize);
    const currentValue = Math.min(maximum, Math.max(lower, value));
    const rowCenter = (rowTop + rowBottom) / 2;
    const halfRowHeight = (rowBottom - rowTop) / 2;
    const zoneStart = currentValue + pageSize * 0.40 - halfRowHeight;
    const zoneEnd = currentValue + pageSize * 0.58 + halfRowHeight;
    if (!force && rowCenter >= zoneStart && rowCenter <= zoneEnd)
        return null;

    const target = rowCenter - pageSize * 0.47;
    return Math.min(maximum, Math.max(lower, target));
}
