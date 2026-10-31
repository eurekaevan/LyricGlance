import Gio from 'gi://Gio';

import {TranslationCredentialStore} from './credentials.js';
import {TranslationDiskCache} from './translation-cache.js';
import {buildTranslationChunks} from './translation-batching.js';
import {
    createTranslationDocument,
    languagesEquivalent,
    sourceLyricsHash,
    sourceLyricsLanguage,
    validateTranslationLines,
} from './translation-document.js';
import {
    OpenAITranslationProvider,
    TranslationProviderError,
} from './translation-provider.js';

const MAX_CONCURRENT_CHUNKS = 3;

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
        if (!options.forceRefresh) {
            const cached = await this._cache.get(
                cacheOptions, options.trackKey, options.cancellable);
            if (cached.hit) {
                return notify({
                    status: TranslationStatus.AVAILABLE,
                    document: cached.document,
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
        this._maintenanceCancellable?.cancel();
        this._maintenanceCancellable = null;
        for (const provider of this._providers.values())
            provider.destroy?.();
        this._providers.clear();
    }
}
