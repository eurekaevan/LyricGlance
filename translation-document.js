import GLib from 'gi://GLib';
import {francAll} from './franc.mjs';

export const TRANSLATION_DOCUMENT_VERSION = 2;

function checksum(value) {
    return GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256, value, -1);
}

function requiredString(value, name) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`Translation ${name} is required`);
    return value.trim();
}

export function sourceLyricsHash(document) {
    if (!document?.lines?.length)
        return null;

    return checksum(JSON.stringify(document.lines.map(line =>
        [line.lineId, line.text])));
}

export function translationCacheKey({
    sourceLyricsHash: lyricsHash,
    targetLanguage,
    provider,
    providerConfiguration = provider,
    model,
    version = TRANSLATION_DOCUMENT_VERSION,
}) {
    return checksum(JSON.stringify([
        version,
        requiredString(lyricsHash, 'source lyrics hash'),
        requiredString(targetLanguage, 'target language'),
        requiredString(provider, 'provider'),
        requiredString(providerConfiguration, 'provider configuration'),
        requiredString(model, 'model'),
    ]));
}

function primaryLanguage(language) {
    if (typeof language !== 'string')
        return null;
    try {
        const code = Intl.getCanonicalLocales(language.trim().replaceAll('_', '-'))[0]
            ?.split('-')[0];
        return !code || ['und', 'mul', 'zxx', 'unknown'].includes(code) ? null : code;
    } catch {
        return null;
    }
}

export function languagesEquivalent(sourceLanguage, targetLanguage) {
    const source = primaryLanguage(sourceLanguage);
    return source !== null && source === primaryLanguage(targetLanguage);
}

export function sourceLyricsLanguage(document) {
    const explicit = primaryLanguage(document?.metadata?.language);
    if (explicit)
        return explicit;
    // Repeated refrains must not turn a tiny sample into false confidence.
    const text = [...new Set(document?.lines?.map(line => line.text.trim()) ?? [])].join('\n');
    if (text.length > 8192 || (text.match(/\p{L}/gu)?.length ?? 0) < 80)
        return 'unknown';
    const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
    const eastAsian = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
        ?.length ?? 0;
    if (latin >= 24 && eastAsian >= 24)
        return 'unknown';
    // franc considers at most 2048 UTF-16 units. Cover the entire bounded
    // text with smaller samples rather than trusting just the opening verse.
    const samples = [];
    const size = Math.ceil(text.length / Math.max(2, Math.ceil(text.length / 1024)));
    for (let start = 0; start < text.length; start += size)
        samples.push(text.slice(start, start + size));
    if (text.length <= 2048)
        samples.push(text);
    let language = null;
    for (const sample of samples) {
        if ((sample.match(/\p{L}/gu)?.length ?? 0) < 30)
            return 'unknown';
        const candidates = francAll(sample, {minLength: 30});
        const best = primaryLanguage(candidates[0]?.[0]);
        // Scores are relative ranks, not calibrated probabilities.
        if (!best || (candidates[1] && candidates[0][1] - candidates[1][1] < 0.1) ||
            (language && best !== language))
            return 'unknown';
        language = best;
    }
    return language ?? 'unknown';
}

export function validateTranslationLines(document, response) {
    if (!response || typeof response !== 'object' ||
        !Array.isArray(response.lines))
        throw new Error('Translation response must contain a lines array');

    const knownIds = new Set(document.lines.map(line => line.lineId));
    const seenIds = new Set();
    const lines = [];
    for (const line of response.lines) {
        if (!line || typeof line !== 'object' ||
            typeof line.id !== 'string' || typeof line.text !== 'string')
            throw new Error('Translation response contains an invalid line');
        if (!knownIds.has(line.id))
            throw new Error(`Translation response contains unknown line ID ${line.id}`);
        if (seenIds.has(line.id))
            throw new Error(`Translation response contains duplicate line ID ${line.id}`);
        seenIds.add(line.id);
        lines.push({lineId: line.id, text: line.text});
    }

    return lines;
}

export function createTranslationDocument({
    trackKey,
    sourceLyricsHash: lyricsHash,
    sourceLanguage = 'unknown',
    targetLanguage,
    provider,
    providerConfiguration = provider,
    model,
    createdAt = new Date().toISOString(),
    lines = [],
}) {
    const seenIds = new Set();
    const normalizedLines = lines.map(line => {
        const lineId = requiredString(line?.lineId, 'line ID');
        if (seenIds.has(lineId))
            throw new Error(`Duplicate TranslationDocument line ID ${lineId}`);
        if (typeof line.text !== 'string')
            throw new Error(`Translation text for ${lineId} must be a string`);
        seenIds.add(lineId);
        return Object.freeze({lineId, text: line.text});
    });

    const created = new Date(createdAt);
    if (!Number.isFinite(created.getTime()))
        throw new Error('Translation createdAt is invalid');

    return Object.freeze({
        version: TRANSLATION_DOCUMENT_VERSION,
        trackKey: requiredString(trackKey, 'track key'),
        sourceLyricsHash: requiredString(lyricsHash, 'source lyrics hash'),
        sourceLanguage: typeof sourceLanguage === 'string' && sourceLanguage
            ? sourceLanguage
            : 'unknown',
        targetLanguage: requiredString(targetLanguage, 'target language'),
        provider: requiredString(provider, 'provider'),
        providerConfiguration: requiredString(
            providerConfiguration, 'provider configuration'),
        model: requiredString(model, 'model'),
        createdAt: created.toISOString(),
        lines: Object.freeze(normalizedLines),
    });
}

export function alignTranslation(document, translation) {
    const translations = new Map(
        translation?.lines?.map(line => [line.lineId, line.text]) ?? []);
    return document.lines.map(line => translations.get(line.lineId) ?? null);
}
