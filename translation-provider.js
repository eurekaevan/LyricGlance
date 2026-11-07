import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {closeStream, readLimited, ResponseTooLargeError, USER_AGENT} from './network-utils.js';

import {validateTranslationLines} from './translation-document.js';

const OPENAI_PROVIDER_ID = 'openai';
const OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RATE_LIMIT_DELAY_MS = 30_000;
const DEFAULT_REASONING_EFFORT = 'none';
// Bump when translation instructions or output policy change to avoid stale results.
const TRANSLATION_PROMPT_VERSION = 3;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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

function providerConfigurationId(endpoint) {
    return GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256,
        JSON.stringify([endpoint ?? 'invalid', TRANSLATION_PROMPT_VERSION]), -1);
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

        return GLib.Bytes.new(await readLimited(
            stream, limit, cancellable, errorResponse));
    } finally {
        await closeStream(stream);
    }
}

export class TranslationProviderError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'TranslationProviderError';
        this.code = code;
    }
}

function invalidResponse(reason) {
    // Only fixed classifications belong here, never provider text or line IDs.
    console.warn(`LyricGlance: invalid translation response reason=${reason}`);
    return new TranslationProviderError(
        'invalid_response', 'Translation response was invalid');
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

async function delay(milliseconds, cancellable) {
    if (cancellable?.is_cancelled())
        throw canceledError();

    let signalId = 0;
    let timerId = 0;
    try {
        await new Promise((resolve, reject) => {
            timerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                Math.max(1, Math.ceil(milliseconds)),
                () => {
                    timerId = 0;
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
            GLib.Source.set_name_by_id(timerId, '[LyricGlance] translation retry delay');
            signalId = cancellable?.connect(() => reject(canceledError())) ?? 0;
        });
    } finally {
        if (timerId)
            GLib.source_remove(timerId);
        // Disconnect after the cancellation callback has returned: disconnect()
        // waits for an active callback and would deadlock from inside it.
        if (signalId)
            cancellable.disconnect(signalId);
    }
}

function outputText(response) {
    if (!response || !Array.isArray(response.output))
        throw invalidResponse('missing_output');

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
        throw invalidResponse('missing_output_text');
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
            'Lyrics may mix languages: translate every line, including words or lines in languages other than sourceLanguage, into the target language.',
            'sourceLanguage is only a hint, not a filter. Detect the language of each line and phrase.',
            'Translate meaningful foreign-language phrases, including English refrains inside mixed-language lines; do not preserve them merely because they use Latin letters.',
            'Text already in the target language and proper names may remain unchanged.',
            'Use the full supplied context to preserve meaning and repeated lines.',
            'Write concise, natural lyrics. Do not censor, embellish, or explain.',
            'Never alter IDs. Return exactly one translation for every requested line ID as structured JSON, without omitting lines in other languages.',
            'The JSON must be an object with a top-level "lines" array; each item has exactly "id" and "text" string fields.',
            'Example shape: {"lines":[{"id":"<exact requested ID>","text":"<translated text>"}]}. Do not use another top-level field or Markdown fences.',
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
        this.configurationId = providerConfigurationId(this._endpoint);
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
        await this.translate({metadata: {}}, {
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
                throw invalidResponse('response_too_large');
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
            const retryDelayLimitMs = Math.min(MAX_RATE_LIMIT_DELAY_MS,
                (this._session.timeout || Infinity) * 1000);
            if (attempt < MAX_RATE_LIMIT_RETRIES && retryAfterMs <= retryDelayLimitMs) {
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
        try {
            response = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        } catch {
            throw invalidResponse('response_json');
        }
        if (response?.status && response.status !== 'completed') {
            throw invalidResponse(response.status === 'incomplete' &&
                response.incomplete_details?.reason === 'max_output_tokens'
                ? 'output_limit' : 'response_not_completed');
        }
        const text = outputText(response);
        let translated;
        try {
            translated = JSON.parse(text);
        } catch {
            throw invalidResponse('translation_json');
        }
        // Some compatible endpoints return this alias despite strict schema.
        // Normalize only its container; IDs and completeness stay mandatory.
        if (translated && !Object.hasOwn(translated, 'lines') &&
            Array.isArray(translated.translations)) {
            translated = {lines: translated.translations};
        }

        const chunkDocument = {
            lines: options.chunk.lines.map(line => ({lineId: line.id})),
        };
        let lines;
        try {
            lines = validateTranslationLines(chunkDocument, translated);
        } catch {
            throw invalidResponse('line_schema');
        }
        if (lines.length !== chunkDocument.lines.length)
            throw invalidResponse('missing_lines');
        if (lines.some(line => !line.text.trim()))
            throw invalidResponse('blank_translation');
        return lines;
    }

    destroy() {
        this._session.abort();
        this._session = null;
    }
}
