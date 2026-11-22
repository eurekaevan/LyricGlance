import {createLyricsDocument, MAX_LYRICS_LINES} from './lyrics-document.js';

const MAX_LRC_OFFSET_MS = 600_000;

export class LrcParser {
    static parse(lrc) {
        if (typeof lrc !== 'string' || !lrc.trim())
            return [];

        const offsetMatch = lrc.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/im);
        const rawOffsetMs = offsetMatch ? Number(offsetMatch[1]) : 0;
        const offsetUs = Number.isFinite(rawOffsetMs) &&
            Math.abs(rawOffsetMs) <= MAX_LRC_OFFSET_MS
            ? rawOffsetMs * 1000
            : 0;
        const entries = [];

        for (const sourceLine of lrc.split(/\r\n?|\n/)) {
            const leading = /^\s*((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,4})?\]\s*)+)(.*)$/
                .exec(sourceLine);
            if (!leading)
                continue;

            const timestamp = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,4})?)\]/g;
            const times = [];
            let match;

            while ((match = timestamp.exec(leading[1])) !== null) {
                const minutes = Number(match[1]);
                const seconds = Number(match[2].replace(':', '.'));
                const timeUs = Math.max(0,
                    Math.round((minutes * 60 + seconds) * 1_000_000) - offsetUs);
                times.push(timeUs);
            }

            if (times.length === 0)
                continue;

            const text = leading[2]
                .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,4})?>/g, '')
                .trim();
            for (const timeUs of times) {
                if (entries.length >= MAX_LYRICS_LINES)
                    return [];
                entries.push({timeUs, text});
            }
        }

        entries.sort((a, b) => a.timeUs - b.timeUs);

        const deduplicated = [];
        let seenTexts = null;
        let currentParts = null;
        for (const entry of entries) {
            const previous = deduplicated.at(-1);
            if (previous?.timeUs === entry.timeUs) {
                if (!entry.text)
                    continue;
                if (!seenTexts.has(entry.text)) {
                    seenTexts.add(entry.text);
                    currentParts.push(entry.text);
                }
            } else {
                if (previous)
                    previous.text = currentParts.join('\n');
                currentParts = entry.text ? [entry.text] : [];
                seenTexts = new Set(currentParts);
                deduplicated.push({timeUs: entry.timeUs, text: entry.text});
            }
        }
        if (deduplicated.length > 0)
            deduplicated.at(-1).text = currentParts.join('\n');

        return deduplicated;
    }

    static parseDocument(lrc, {
        source = 'lrclib-synced',
        sourceId = null,
        metadata = {},
    } = {}) {
        return createLyricsDocument({
            source,
            sourceId,
            metadata,
            lines: this.parse(lrc).map(line => ({
                text: line.text,
                startMs: Math.round(line.timeUs / 1000),
                endMs: null,
                words: [],
            })),
        });
    }
}
