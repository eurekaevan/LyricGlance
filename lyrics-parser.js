import {createLyricsDocument} from './lyrics-document.js';

export class LrcParser {
    static parse(lrc) {
        if (typeof lrc !== 'string' || !lrc.trim())
            return [];

        const offsetMatch = lrc.match(/^\s*\[offset:([+-]?\d+)\]\s*$/im);
        const offsetUs = offsetMatch ? Number(offsetMatch[1]) * 1000 : 0;
        const entries = [];

        for (const sourceLine of lrc.split(/\r?\n/)) {
            const timestamp = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;
            const times = [];
            let match;

            while ((match = timestamp.exec(sourceLine)) !== null) {
                const minutes = Number(match[1]);
                const seconds = Number(match[2]);
                const timeUs = Math.max(0,
                    Math.round((minutes * 60 + seconds) * 1_000_000) + offsetUs);
                times.push(timeUs);
            }

            if (times.length === 0)
                continue;

            const text = sourceLine.replace(timestamp, '').trim();
            for (const timeUs of times)
                entries.push({timeUs, text});
        }

        entries.sort((a, b) => a.timeUs - b.timeUs);

        const deduplicated = [];
        for (const entry of entries) {
            const previous = deduplicated.at(-1);
            if (previous?.timeUs === entry.timeUs)
                previous.text = entry.text;
            else
                deduplicated.push(entry);
        }

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
