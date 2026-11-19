import {createLyricsDocument, createPlainLyricsDocument, SyncLevel} from './lyrics-document.js';
import {LrcParser} from './lyrics-parser.js';
import {LyricsfileParser} from './lyricsfile-parser.js';

function providerMetadata(payload) {
    return {
        title: payload?.trackName ?? payload?.name ?? '',
        artist: payload?.artistName ?? '',
        album: payload?.albumName ?? '',
        durationMs: Number.isFinite(payload?.duration)
            ? Math.max(0, Math.round(payload.duration * 1000))
            : null,
    };
}

export function normalizeLyricsPayload(payload, {onLyricsfileError = null} = {}) {
    if (!payload || typeof payload !== 'object')
        return null;

    const provider = payload.provider === 'lrcapi' ? 'lrcapi' : 'lrclib';
    const sourceId = payload.id ?? null;
    const metadata = providerMetadata(payload);
    let lyricsfileDocument = null;

    if (typeof payload.lyricsfile === 'string' && payload.lyricsfile.trim()) {
        try {
            lyricsfileDocument = LyricsfileParser.parse(payload.lyricsfile, {
                sourceId,
                providerMetadata: metadata,
            });
            if (lyricsfileDocument.instrumental ||
                (lyricsfileDocument.syncLevel !== SyncLevel.NONE &&
                    lyricsfileDocument.lines.some(line => line.text.trim())))
                return lyricsfileDocument;
        } catch (error) {
            onLyricsfileError?.(error);
        }
    }

    if (payload.instrumental === true) {
        return createLyricsDocument({
            source: provider,
            sourceId,
            instrumental: true,
            metadata,
        });
    }

    // LrcAPI's lyrics/lrc fields can both contain timed or plain text. Check
    // them here so network responses and legacy cached aliases use one rule.
    const texts = provider === 'lrcapi'
        ? [payload.plainLyrics, payload.syncedLyrics]
        : [payload.syncedLyrics];
    let plainLyrics = null;
    for (const text of texts) {
        if (typeof text !== 'string' || !text.trim())
            continue;
        const syncedDocument = LrcParser.parseDocument(text, {
            source: `${provider}-synced`, sourceId, metadata,
        });
        if (syncedDocument.syncLevel === SyncLevel.LINE &&
            syncedDocument.lines.some(line => line.text.trim()))
            return syncedDocument;
        if (provider === 'lrcapi' && syncedDocument.lines.length === 0 && plainLyrics === null)
            plainLyrics = text;
    }
    if (provider !== 'lrcapi' && typeof payload.plainLyrics === 'string' && payload.plainLyrics.trim())
        plainLyrics = payload.plainLyrics;
    if (plainLyrics !== null) {
        return createPlainLyricsDocument(plainLyrics, {
            source: `${provider}-plain`,
            sourceId,
            metadata,
        });
    }

    if (lyricsfileDocument?.lines.some(line => line.text.trim()))
        return lyricsfileDocument;

    return null;
}
