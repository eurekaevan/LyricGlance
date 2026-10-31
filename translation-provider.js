import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {validateTranslationLines} from './translation-document.js';

const OPENAI_PROVIDER_ID = 'openai';
const OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const USER_AGENT = 'LyricGlance/0.9.0 (lyric-glance@eureka)';
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_REASONING_EFFORT = 'none';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

Gio._promisify(Gio.InputStream.prototype,
    'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype,
    'close_async', 'close_finish');
Gio._promisify(Soup.Session.prototype,
    'send_async', 'send_finish');

class ResponseTooLargeError extends Error {}

export function translationNetworkReason(error) {
    if (error.domain === Gio.tls_error_quark())
        return 'tls';
    if (error.domain === Gio.resolver_error_quark())
        return 'dns';
    const matches = code => error.matches?.(Gio.IOErrorEnum, code);
    if (matches(Gio.IOErrorEnum.TIMED_OUT))
        return 'timeout';
    if (matches(Gio.IOErrorEnum.HOST_NOT_FOUND))
        return 'dns';
    if ([Gio.IOErrorEnum.PROXY_FAILED, Gio.IOErrorEnum.PROXY_AUTH_FAILED,
        Gio.IOErrorEnum.PROXY_NEED_AUTH, Gio.IOErrorEnum.PROXY_NOT_ALLOWED].some(matches))
        return 'proxy';
    if ([Gio.IOErrorEnum.CONNECTION_CLOSED, Gio.IOErrorEnum.PARTIAL_INPUT].some(matches))
        return 'connection_closed';
    if ([Gio.IOErrorEnum.CONNECTION_REFUSED, Gio.IOErrorEnum.HOST_UNREACHABLE,
        Gio.IOErrorEnum.NETWORK_UNREACHABLE, Gio.IOErrorEnum.NOT_CONNECTED].some(matches))
        return 'connection';
    return 'unknown';
}

export function normalizeTranslationEndpoint(endpoint) {
    if (typeof endpoint !== 'string')
        return null;

    const value = endpoint.trim();
    if (!value)
        return null;

    try {
        const uri = GLib.Uri.parse(value, GLib.UriFlags.NONE);
        const scheme = uri.get_scheme()?.toLowerCase();
        const host = uri.get_host()?.toLowerCase();
        if (!['http', 'https'].includes(scheme) || !uri.get_host() ||
            uri.get_userinfo() || uri.get_query() || uri.get_fragment())
            return null;
        if (scheme === 'http' && !['localhost', '127.0.0.1', '::1']
            .includes(host))
            return null;
    } catch {
        return null;
    }

    return value;
}

function endpointConfigurationId(endpoint) {
    return GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256, endpoint ?? 'invalid', -1);
}

async function readResponse(session, message, limit, cancellable) {
    const stream = await session.send_async(
        message, GLib.PRIORITY_DEFAULT, cancellable);
    try {
        const errorResponse = message.status_code < 200 || message.status_code >= 300;
        if (errorResponse)
            limit = Math.min(limit, 16 * 1024);

        const contentLength = message.get_response_headers()
            .get_content_length();
        if (!errorResponse && contentLength > limit)
            throw new ResponseTooLargeError();

        const chunks = [];
        let total = 0;
        while (true) {
            if (errorResponse && total >= limit)
                break;
            const bytes = await stream.read_bytes_async(
                errorResponse ? Math.min(READ_CHUNK_BYTES, limit - total) : READ_CHUNK_BYTES,
                GLib.PRIORITY_DEFAULT, cancellable);
            const size = bytes.get_size();
            if (size === 0)
                break;
            total += size;
            if (total > limit)
                throw new ResponseTooLargeError();
            chunks.push(bytes.get_data());
        }

        const contents = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            contents.set(chunk, offset);
            offset += chunk.length;
        }
        return GLib.Bytes.new(contents);
    } finally {
        try {
            await stream.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch {
            // The request error is more useful than a stream-close error.
        }
    }
}

export class TranslationProviderError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'TranslationProviderError';
        this.code = code;
    }
}

function translationRetryAfterMs(value, now = Date.now()) {
    if (typeof value !== 'string' || !value.trim())
        return 5000;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.max(1000, Math.ceil(seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date))
        return Math.max(1000, date - now);
    return 5000;
}

function canceledError() {
    return new TranslationProviderError('canceled', 'Translation canceled');
}

function delay(milliseconds, cancellable) {
    if (cancellable?.is_cancelled())
        return Promise.reject(canceledError());

    return new Promise((resolve, reject) => {
        let signalId = 0;
        let timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil(milliseconds)),
            () => {
                timerId = 0;
                if (signalId) {
                    cancellable.disconnect(signalId);
                    signalId = 0;
                }
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        if (cancellable) {
            signalId = cancellable.connect(() => {
                if (timerId) {
                    GLib.source_remove(timerId);
                    timerId = 0;
                }
                if (signalId) {
                    cancellable.disconnect(signalId);
                    signalId = 0;
                }
                reject(canceledError());
            });
        }
    });
}

function outputText(response) {
    if (!response || !Array.isArray(response.output))
        throw new TranslationProviderError(
            'invalid_response', 'Provider response has no output');

    const parts = [];
    for (const output of response.output) {
        if (output?.type !== 'message' || !Array.isArray(output.content))
            continue;
        for (const content of output.content) {
            if (content?.type === 'refusal') {
                throw new TranslationProviderError(
                    'provider_error', 'Provider refused the translation');
            }
            if (content?.type === 'output_text' && typeof content.text === 'string')
                parts.push(content.text);
        }
    }
    if (parts.length === 0)
        throw new TranslationProviderError(
            'invalid_response', 'Provider response contains no text');
    return parts.join('');
}

function responseSchema(ids) {
    return {
        type: 'object',
        properties: {
            lines: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: {type: 'string', enum: ids},
                        text: {type: 'string'},
                    },
                    required: ['id', 'text'],
                    additionalProperties: false,
                },
            },
        },
        required: ['lines'],
        additionalProperties: false,
    };
}

function requestBody(document, options, model, reasoningEffort) {
    const input = {
        title: document.metadata?.title ?? '',
        artist: document.metadata?.artist ?? '',
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        contextBefore: options.chunk.contextBefore.map(line => line.text),
        lines: options.chunk.lines,
        contextAfter: options.chunk.contextAfter.map(line => line.text),
    };
    const ids = options.chunk.lines.map(line => line.id);
    const body = {
        model,
        store: false,
        instructions: [
            'Translate song lyrics into the requested target language.',
            'Use the full supplied context to preserve meaning and repeated lines.',
            'Write concise, natural lyrics. Do not censor, embellish, or explain.',
            'Never alter IDs. Return only the requested lines as structured JSON.',
            'Do not add timestamps. Preserve non-lyric semantics when present.',
        ].join(' '),
        input: JSON.stringify(input),
        text: {
            format: {
                type: 'json_schema',
                name: 'lyrics_translation',
                strict: true,
                schema: responseSchema(ids),
            },
        },
        max_output_tokens: options.maxOutputTokens ?? 12_000,
    };
    // Reasoning models (e.g. Qwen3.8 defaults to xhigh) otherwise spend most
    // of the request thinking, which translation does not need.
    if (reasoningEffort)
        body.reasoning = {effort: reasoningEffort};
    return body;
}

export class OpenAITranslationProvider {
    constructor({
        endpoint = OPENAI_RESPONSES_URL,
        model = OPENAI_MODEL,
        timeoutSeconds = 120,
        maxResponseBytes = MAX_RESPONSE_BYTES,
        reasoningEffort = DEFAULT_REASONING_EFFORT,
    } = {}) {
        this.id = OPENAI_PROVIDER_ID;
        this.model = typeof model === 'string' ? model.trim() : '';
        this.requiresCredential = true;
        this._endpoint = normalizeTranslationEndpoint(endpoint);
        this.configurationId = endpointConfigurationId(this._endpoint);
        this._reasoningEffort = reasoningEffort;
        this._maxResponseBytes = Math.max(1, Math.floor(maxResponseBytes));
        this._session = new Soup.Session({
            timeout: timeoutSeconds,
            'idle-timeout': timeoutSeconds,
            'user-agent': USER_AGENT,
        });
    }

    async translate(document, options, cancellable) {
        return this._request(document, options, cancellable, 0);
    }

    async checkConnection(credential, cancellable) {
        const lines = await this.translate({metadata: {}}, {
            credential,
            sourceLanguage: 'en',
            targetLanguage: 'zh-CN',
            maxOutputTokens: 512,
            chunk: {
                lines: [{id: 'connection-check', text: 'Hello'}],
                contextBefore: [],
                contextAfter: [],
            },
        }, cancellable);
        if (lines.length !== 1 || !lines[0].text.trim()) {
            throw new TranslationProviderError(
                'invalid_response', 'Connection check returned no translation');
        }
    }

    async _request(document, options, cancellable, attempt) {
        if (cancellable?.is_cancelled())
            throw canceledError();

        if (!this.model)
            throw new TranslationProviderError(
                'provider_error', 'Translation model is not configured');

        const message = this._endpoint
            ? Soup.Message.new('POST', this._endpoint)
            : null;
        if (!message)
            throw new TranslationProviderError(
                'provider_error', 'Translation endpoint is invalid');
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        message.get_request_headers().append(
            'Authorization', `Bearer ${options.credential}`);
        const reasoningEffort = this._reasoningEffort;
        const encoded = new TextEncoder().encode(JSON.stringify(
            requestBody(document, options, this.model, reasoningEffort)));
        message.set_request_body_from_bytes(
            'application/json', GLib.Bytes.new(encoded));

        let bytes;
        const startedUs = GLib.get_monotonic_time();
        try {
            bytes = await readResponse(this._session, message,
                this._maxResponseBytes, cancellable);
        } catch (error) {
            if (cancellable?.is_cancelled() ||
                error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw canceledError();
            if (error instanceof ResponseTooLargeError) {
                throw new TranslationProviderError(
                    'invalid_response',
                    'Translation response exceeded the size limit');
            }
            const failure = new TranslationProviderError(
                'network_error', 'Translation network request failed');
            failure.networkReason = translationNetworkReason(error);
            // Never include native error messages: they can contain URLs,
            // credentials or response contents. All fields here are bounded
            // classifications or numbers derived from this request.
            console.warn(`LyricGlance: translation transport failure reason=${failure.networkReason}` +
                ` batch=${(options.chunk.index ?? 0) + 1}/${options.batchCount ?? 1}` +
                ` lines=${options.chunk.lines.length} requestBytes=${encoded.length}` +
                ` elapsedMs=${Math.round((GLib.get_monotonic_time() - startedUs) / 1000)}` +
                ` attempt=${attempt + 1} phase=${message.status_code ? 'read-body' : 'request-or-headers'}` +
                ` nativeCode=${Number.isInteger(error.code) ? error.code : -1}`);
            throw failure;
        }

        const status = message.status_code;
        // Inspect only a bounded error body. Never expose its free-form text.
        let apiError = null;
        if (status < 200 || status >= 300) {
            try {
                apiError = JSON.parse(new TextDecoder().decode(bytes.get_data()))?.error;
            } catch {
                // HTML, oversized and malformed error bodies retain HTTP classification.
            }
        }
        const quotaCodes = new Set(['insufficient_quota', 'quota_exceeded',
            'credit_balance_exhausted', 'billing_hard_limit_reached',
            'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
            'organization_usage_limit_exceeded']);
        if ((status < 200 || status >= 300) &&
            (quotaCodes.has(apiError?.code) || quotaCodes.has(apiError?.type))) {
            throw new TranslationProviderError(
                'quota_exceeded', 'Translation quota or spending limit reached');
        }
        if (status === 429) {
            const retryAfterMs = translationRetryAfterMs(
                message.get_response_headers().get_one('Retry-After'));
            if (attempt < MAX_RATE_LIMIT_RETRIES) {
                await delay(retryAfterMs, cancellable);
                return this._request(
                    document, options, cancellable, attempt + 1);
            }
            throw new TranslationProviderError(
                'rate_limited', 'Translation provider rate limited the request');
        }
        if (status === 401 || status === 403 && apiError?.code === 'invalid_api_key') {
            throw new TranslationProviderError(
                'authentication_error', 'Translation credential was rejected');
        }
        if (status === 403) {
            throw new TranslationProviderError(
                'permission_denied', 'Translation access was denied');
        }
        const reasoningParam = ['reasoning', 'reasoning.effort'].includes(apiError?.param);
        const unsupportedReasoning = (reasoningParam &&
            ['unsupported_parameter', 'unsupported_value', 'unknown_parameter'].includes(apiError?.code)) ||
            (typeof apiError?.message === 'string' &&
                (reasoningParam || /\breasoning(?:[._ ]effort)?\b/i.test(apiError.message)) &&
                /unsupported|not supported|unknown parameter|unrecognized/i.test(apiError.message));
        if (status === 400 && reasoningEffort && unsupportedReasoning) {
            // Each in-flight request owns its retry, even if a sibling already
            // disabled reasoning for subsequent requests on this provider.
            this._reasoningEffort = null;
            return this._request(document, options, cancellable, attempt);
        }
        if (status < 200 || status >= 300) {
            throw new TranslationProviderError(
                'provider_error', `Translation provider returned HTTP ${status}`);
        }

        let response;
        let translated;
        try {
            response = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            translated = JSON.parse(outputText(response));
        } catch (error) {
            if (error instanceof TranslationProviderError)
                throw error;
            throw new TranslationProviderError(
                'invalid_response', 'Translation provider returned invalid JSON');
        }

        const chunkDocument = {
            lines: options.chunk.lines.map(line => ({lineId: line.id})),
        };
        try {
            return validateTranslationLines(chunkDocument, translated);
        } catch {
            throw new TranslationProviderError(
                'invalid_response', 'Translation provider returned invalid line IDs');
        }
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}

export class MockTranslationProvider {
    constructor({
        id = 'mock',
        model = 'mock-v1',
        configurationId = id,
        delayMs = 0,
    } = {}) {
        this.id = id;
        this.model = model;
        this.configurationId = configurationId;
        this.requiresCredential = false;
        this.delayMs = delayMs;
        this.requestCount = 0;
    }

    async translate(_document, options, cancellable) {
        this.requestCount++;
        if (this.delayMs > 0)
            await delay(this.delayMs, cancellable);
        if (cancellable?.is_cancelled())
            throw canceledError();
        return options.chunk.lines.map(line => ({
            lineId: line.id,
            text: `[${options.targetLanguage}] ${line.text}`,
        }));
    }

    destroy() {}
}
