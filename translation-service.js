import Gio from 'gi://Gio';

import {francAll} from './franc.mjs';
import {TranslationCredentialStore} from './credentials.js';
import {TranslationDiskCache} from './translation-cache.js';
import {buildTranslationChunks} from './translation-batching.js';
import {
    createTranslationDocument,
    sourceLyricsHash,
    translationCacheKey,
    validateTranslationLines,
} from './translation-document.js';
import {
    OpenAITranslationProvider,
    TranslationProviderError,
} from './translation-provider.js';

const MAX_CONCURRENT_CHUNKS = 3;
const MAX_MEMORY_CACHE_ENTRIES = 20;

export const TranslationStatus = Object.freeze({
    IDLE: 'idle',
    LOADING: 'loading',
    AVAILABLE: 'available',
    NOT_CONFIGURED: 'not_configured',
    PROVIDER_UNAVAILABLE: 'provider_unavailable',
    NETWORK_ERROR: 'network_error',
    PROVIDER_ERROR: 'provider_error',
    AUTHENTICATION_ERROR: 'authentication_error',
    PERMISSION_DENIED: 'permission_denied',
    QUOTA_EXCEEDED: 'quota_exceeded',
    RATE_LIMITED: 'rate_limited',
    INVALID_RESPONSE: 'invalid_response',
    CANCELED: 'canceled',
    SAME_LANGUAGE: 'same_language',
    SKIPPED: 'skipped',
});

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

export class TranslationService {
    constructor({
        providers = null,
        providerOptions = {},
        credentialStore = new TranslationCredentialStore(),
        cache = new TranslationDiskCache(),
        batchingOptions = {},
    } = {}) {
        const configuredProviders = providers ?? [
            new OpenAITranslationProvider(providerOptions),
        ];
        this._providers = new Map(configuredProviders.map(provider =>
            [provider.id, provider]));
        this._credentialStore = credentialStore;
        this._cache = cache;
        this._batchingOptions = batchingOptions;
        this._inFlight = new Map();
        this._memoryCache = new Map();
        this._maintenanceCancellable = null;
    }

    translate(document, {
        trackKey,
        targetLanguage,
        providerId,
        forceRefresh = false,
        allowNetwork = true,
        onStatus = null,
    }) {
        const provider = this._providers.get(providerId);
        const lyricsHash = sourceLyricsHash(document);
        const requestKey = [
            trackKey,
            lyricsHash,
            targetLanguage,
            providerId,
            provider?.configurationId ?? providerId,
            provider?.model ?? '',
            allowNetwork ? 'network' : 'cache-only',
        ].join('\u0000');
        const existing = this._inFlight.get(requestKey);
        if (existing)
            return existing.promise;

        const cancellable = new Gio.Cancellable();
        const promise = this._translate(document, {
            trackKey,
            targetLanguage,
            provider,
            lyricsHash,
            forceRefresh,
            allowNetwork,
            onStatus,
            cancellable,
        }).finally(() => {
            const current = this._inFlight.get(requestKey);
            if (current?.promise === promise)
                this._inFlight.delete(requestKey);
        });
        this._inFlight.set(requestKey, {promise, cancellable});
        return promise;
    }

    async _translate(document, options) {
        const notify = status => {
            options.onStatus?.(status);
            return status;
        };
        if (options.cancellable.is_cancelled())
            return notify({status: TranslationStatus.CANCELED});
        if (!document || document.instrumental || !options.lyricsHash ||
            !document.lines.some(line => line.text.trim()))
            return notify({status: TranslationStatus.SKIPPED});
        if (typeof options.targetLanguage !== 'string' ||
            !options.targetLanguage.trim())
            return notify({status: TranslationStatus.PROVIDER_ERROR});
        const sourceLanguage = sourceLyricsLanguage(document);
        if (languagesEquivalent(sourceLanguage, options.targetLanguage))
            return notify({status: TranslationStatus.SAME_LANGUAGE});
        if (!options.provider)
            return notify({status: TranslationStatus.PROVIDER_UNAVAILABLE});
        if (typeof options.provider.model !== 'string' ||
            !options.provider.model.trim())
            return notify({status: TranslationStatus.PROVIDER_ERROR});

        const cacheOptions = {
            sourceLyricsHash: options.lyricsHash,
            targetLanguage: options.targetLanguage,
            provider: options.provider.id,
            providerConfiguration: options.provider.configurationId ??
                options.provider.id,
            model: options.provider.model,
        };
        const memoryKey = `${options.trackKey}\u0000${translationCacheKey(cacheOptions)}`;
        if (!options.forceRefresh) {
            let translation = this._memoryCache.get(memoryKey);
            if (!translation) {
                const cached = await this._cache.get(
                    cacheOptions, options.trackKey, options.cancellable);
                if (cached.hit)
                    translation = cached.document;
            }
            if (options.cancellable.is_cancelled())
                return notify({status: TranslationStatus.CANCELED});
            if (translation) {
                this._rememberTranslation(memoryKey, translation);
                return notify({
                    status: TranslationStatus.AVAILABLE,
                    document: translation,
                    fromCache: true,
                });
            }
        }
        if (options.cancellable.is_cancelled())
            return notify({status: TranslationStatus.CANCELED});
        if (!options.allowNetwork)
            return notify({status: TranslationStatus.IDLE});

        notify({status: TranslationStatus.LOADING});
        let credential = null;
        try {
            if (options.provider.requiresCredential) {
                credential = await this._credentialStore.lookup(
                    options.provider.id, options.cancellable);
                if (!credential)
                    return notify({status: TranslationStatus.NOT_CONFIGURED});
            }

            const chunks = buildTranslationChunks(
                document, this._batchingOptions);
            const translatedLines = await this._translateChunks(
                document, chunks, {
                    sourceLanguage,
                    targetLanguage: options.targetLanguage,
                    provider: options.provider,
                    credential,
                    cancellable: options.cancellable,
                });
            if (options.cancellable.is_cancelled())
                return notify({status: TranslationStatus.CANCELED});
            if (translatedLines.length === 0)
                return notify({status: TranslationStatus.INVALID_RESPONSE});

            const translation = createTranslationDocument({
                trackKey: options.trackKey,
                sourceLyricsHash: options.lyricsHash,
                sourceLanguage,
                targetLanguage: options.targetLanguage,
                provider: options.provider.id,
                providerConfiguration:
                    options.provider.configurationId ?? options.provider.id,
                model: options.provider.model,
                lines: translatedLines,
            });
            try {
                await this._cache.put(translation, options.cancellable);
            } catch {
                console.warn('LyricGlance: could not save translation cache');
            }
            if (options.cancellable.is_cancelled())
                return notify({status: TranslationStatus.CANCELED});
            this._rememberTranslation(memoryKey, translation);
            return notify({
                status: TranslationStatus.AVAILABLE,
                document: translation,
                fromCache: false,
            });
        } catch (error) {
            if (options.cancellable.is_cancelled() ||
                error instanceof TranslationProviderError &&
                error.code === 'canceled')
                return notify({status: TranslationStatus.CANCELED});
            const known = new Set(Object.values(TranslationStatus));
            const status = error instanceof TranslationProviderError &&
                known.has(error.code)
                ? error.code
                : TranslationStatus.PROVIDER_ERROR;
            return notify({status, networkReason: error instanceof TranslationProviderError
                ? error.networkReason : undefined});
        } finally {
            credential = null;
        }
    }

    _rememberTranslation(key, document) {
        this._memoryCache.delete(key);
        this._memoryCache.set(key, document);
        if (this._memoryCache.size > MAX_MEMORY_CACHE_ENTRIES)
            this._memoryCache.delete(this._memoryCache.keys().next().value);
    }

    _validateChunk(chunk, lines) {
        try {
            if (!Array.isArray(lines))
                throw new Error('Provider lines must be an array');
            return validateTranslationLines(
                {lines: chunk.lines.map(line => ({lineId: line.id}))},
                {lines: lines.map(line => ({
                    id: line?.lineId,
                    text: line?.text,
                }))});
        } catch {
            throw new TranslationProviderError(
                'invalid_response',
                'Translation provider returned invalid line IDs');
        }
    }

    async _translateChunks(document, chunks, {
        sourceLanguage, targetLanguage, provider, credential, cancellable,
    }) {
        const results = new Array(chunks.length);
        // Abort sibling requests as soon as one chunk fails.
        const workCancellable = new Gio.Cancellable();
        const signalId = cancellable.connect(() => workCancellable.cancel());
        let failure = null;
        let next = 0;

        const worker = async () => {
            while (!failure && next < chunks.length &&
                !workCancellable.is_cancelled()) {
                const index = next++;
                const chunk = chunks[index];
                try {
                    const lines = await provider.translate(document, {
                        sourceLanguage,
                        targetLanguage,
                        credential,
                        chunk,
                        batchCount: chunks.length,
                    }, workCancellable);
                    results[index] = this._validateChunk(chunk, lines);
                } catch (error) {
                    if (!failure && !cancellable.is_cancelled()) {
                        failure = error;
                        workCancellable.cancel();
                    }
                    return;
                }
            }
        };

        try {
            await Promise.all(Array.from(
                {length: Math.min(MAX_CONCURRENT_CHUNKS, chunks.length)},
                worker));
        } finally {
            cancellable.disconnect(signalId);
        }
        if (failure)
            throw failure;
        return results.flat();
    }

    cancelAll() {
        for (const {cancellable} of this._inFlight.values())
            cancellable.cancel();
    }

    async clearCache() {
        this.cancelAll();
        this._memoryCache.clear();
        this._maintenanceCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._maintenanceCancellable = cancellable;
        try {
            await this._cache.clear(cancellable);
        } finally {
            if (this._maintenanceCancellable === cancellable)
                this._maintenanceCancellable = null;
        }
    }

    destroy() {
        this.cancelAll();
        this._memoryCache.clear();
        this._maintenanceCancellable?.cancel();
        this._maintenanceCancellable = null;
        this._cache.destroy();
        for (const provider of this._providers.values())
            provider.destroy?.();
        this._providers.clear();
    }
}
