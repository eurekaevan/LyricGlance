import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {createLyricsDocument} from '../lyrics-document.js';
import {removeTree} from '../storage.js';
import {TranslationDiskCache} from '../translation-cache.js';
import {createTranslationDocument, sourceLyricsHash} from '../translation-document.js';
import {TranslationService, TranslationStatus} from '../translation-service.js';
import {
    normalizeTranslationEndpoint,
    OpenAITranslationProvider,
    TranslationProviderError,
    translationNetworkReason,
} from '../translation-provider.js';

// GJS console methods are read-only; observe their structured log output.
const diagnostics = [];
GLib.log_set_writer_func((level, fields) => {
    if (!(level & (GLib.LogLevelFlags.LEVEL_DEBUG | GLib.LogLevelFlags.LEVEL_INFO))) {
        const message = new TextDecoder().decode(fields.MESSAGE ?? new Uint8Array());
        diagnostics.push(message);
        printerr(message);
    }
    return GLib.LogWriterOutput.HANDLED;
});

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function response(lines, field = 'lines') {
    return JSON.stringify({
        output: [{
            type: 'message',
            content: [{
                type: 'output_text',
                text: JSON.stringify({[field]: lines}),
            }],
        }],
    });
}

const lyrics = createLyricsDocument({
    source: 'test',
    metadata: {title: 'HTTP Test', artist: 'Fixture', language: 'en'},
    lines: [
        {text: 'Hello', startMs: 0, endMs: 1000},
        {text: 'Again', startMs: 1000, endMs: 2000},
    ],
});
const chunk = {
    index: 0,
    contextBefore: [],
    contextAfter: [],
    lines: lyrics.lines.map(line => ({id: line.lineId, text: line.text})),
};
const mixedLyrics = createLyricsDocument({
    source: 'test',
    metadata: {title: 'Mixed-language fixture', language: 'ja'},
    lines: [
        {text: '明日も君と歩きたい', startMs: 0, endMs: 1000},
        {text: 'Stay with me tonight', startMs: 1000, endMs: 2000},
        {text: '君と forever in my heart', startMs: 2000, endMs: 3000},
        {text: '已经是中文', startMs: 3000, endMs: 4000},
    ],
});
const mixedTranslations = ['明天也想与你同行', '今晚留在我身边', '你永远在我心中', '已经是中文'];

const server = new Soup.Server();
let mode = 'success';
let requestCount = 0;
let retryAfter = '0';
let observed = null;
let cancelDuringRequest = null;
let httpError = null;
server.add_handler(null, (_server, message) => {
    requestCount++;
    if (mode === 'slow') {
        server.pause_message(message);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            message.set_status(Soup.Status.OK, null);
            server.unpause_message(message);
            return GLib.SOURCE_REMOVE;
        });
        return;
    }
    cancelDuringRequest?.cancel();
    const body = new TextDecoder().decode(
        message.get_request_body().flatten().get_data());
    observed = {
        authorization: message.get_request_headers().get_one('Authorization'),
        userAgent: message.get_request_headers().get_one('User-Agent'),
        body: JSON.parse(body),
    };
    if (mode === 'http-error') {
        message.set_status(httpError.status, null);
        message.set_response('application/json', Soup.MemoryUse.COPY,
            new TextEncoder().encode(httpError.body ?? JSON.stringify({error: httpError.error})));
        return;
    }
    if (mode === 'rate-limit' && requestCount === 1) {
        message.set_status(429, null);
        message.get_response_headers().append('Retry-After', retryAfter);
        return;
    }
    if (mode === 'authentication') {
        message.set_status(Soup.Status.UNAUTHORIZED, null);
        return;
    }
    if (mode === 'reject-reasoning' && observed.body.reasoning) {
        message.set_status(Soup.Status.BAD_REQUEST, null);
        message.set_response('application/json', Soup.MemoryUse.COPY,
            new TextEncoder().encode(JSON.stringify({error: {
                code: 'unsupported_parameter', param: 'reasoning',
            }})));
        return;
    }
    if (mode === 'redirect') {
        message.set_status(Soup.Status.TEMPORARY_REDIRECT, null);
        message.get_response_headers().append(
            'Location', `${endpoint}/redirected`);
        return;
    }
    message.set_status(Soup.Status.OK, null);
    let output;
    if (mode === 'malformed')
        output = '{bad json';
    else if (mode === 'unknown-id' || mode === 'alias-unknown-id')
        output = response([{id: mode === 'alias-unknown-id' ? 'private-response-content' : 'unknown',
            text: '错误'}],
            mode === 'alias-unknown-id' ? 'translations' : 'lines');
    else if (mode === 'missing-output')
        output = JSON.stringify({status: 'completed', detail: 'private-response-content'});
    else if (mode === 'missing-text')
        output = JSON.stringify({status: 'completed', output: []});
    else if (mode === 'invalid-translation-json')
        output = JSON.stringify({output: [{type: 'message', content: [{
            type: 'output_text', text: 'private-response-content not JSON',
        }]}]});
    else if (mode === 'empty')
        output = response([]);
    else if (['mixed', 'mixed-partial', 'mixed-blank'].includes(mode))
        output = response(JSON.parse(observed.body.input).lines
            .filter((_line, index) => mode !== 'mixed-partial' || index !== 1)
            .map(line => ({id: line.id,
                text: mode === 'mixed-blank' && line.id === mixedLyrics.lines[1].lineId
                    ? '  '
                    : mixedTranslations[mixedLyrics.lines.findIndex(original =>
                        original.lineId === line.id)]})));
    else {
        const inputLines = JSON.parse(observed.body.input).lines;
        output = response(inputLines.map(line => ({
            id: mode === 'alias-duplicate' ? inputLines[0].id : line.id,
            text: mode === 'blank' || mode === 'alias-blank' ? '  ' : `[zh-CN] ${line.text}`,
        })).filter((_line, index) => mode !== 'alias-partial' || index === 0),
        mode.startsWith('alias-') ? 'translations' : 'lines');
        if (mode === 'alias-conflict') {
            const envelope = JSON.parse(output);
            const payload = JSON.parse(envelope.output[0].content[0].text);
            payload.lines = 'invalid canonical container';
            envelope.output[0].content[0].text = JSON.stringify(payload);
            output = JSON.stringify(envelope);
        } else if (mode === 'incomplete') {
            const envelope = JSON.parse(output);
            envelope.status = 'incomplete';
            envelope.incomplete_details = {reason: 'max_output_tokens'};
            output = JSON.stringify(envelope);
        }
    }
    message.set_response(
        'application/json',
        Soup.MemoryUse.COPY,
        new TextEncoder().encode(output));
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const endpoint = server.get_uris()[0].to_string().replace(/\/$/, '');

async function translate(provider) {
    return provider.translate(lyrics, {
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        credential: 'unit-test-token',
        chunk,
    }, null);
}

async function expectCode(callback, code, message) {
    let caught = null;
    try {
        await callback();
    } catch (error) {
        caught = error;
    }
    assert(caught instanceof TranslationProviderError && caught.code === code,
        message);
}

async function run() {
    for (const [domain, code, reason] of [
        [Gio.io_error_quark(), Gio.IOErrorEnum.TIMED_OUT, 'timeout'],
        [Gio.resolver_error_quark(), Gio.ResolverError.NOT_FOUND, 'dns'],
        [Gio.tls_error_quark(), Gio.TlsError.BAD_CERTIFICATE, 'tls'],
        [Gio.io_error_quark(), Gio.IOErrorEnum.PROXY_FAILED, 'proxy'],
        [Gio.io_error_quark(), Gio.IOErrorEnum.CONNECTION_CLOSED, 'connection_closed'],
        [Gio.io_error_quark(), Gio.IOErrorEnum.CONNECTION_REFUSED, 'connection'],
        [Gio.io_error_quark(), Gio.IOErrorEnum.FAILED, 'unknown'],
    ]) {
        assert(translationNetworkReason(new GLib.Error(domain, code,
            'secret-token https://private.example/path lyric-text')) === reason,
        `native transport errors must retain their ${reason} classification`);
    }
    assert(normalizeTranslationEndpoint(' https://proxy.example/v1/responses ') ===
        'https://proxy.example/v1/responses' &&
        normalizeTranslationEndpoint(endpoint) === endpoint &&
        normalizeTranslationEndpoint('http://proxy.example/v1/responses') ===
            null &&
        normalizeTranslationEndpoint('https://user@proxy.example/v1/responses') ===
            null &&
        normalizeTranslationEndpoint('not a URL') === null,
    'translation endpoints should be credential-safe HTTP(S) URLs');

    let provider = new OpenAITranslationProvider({
        endpoint,
        model: 'custom-translation-model',
    });
    let result = await translate(provider);
    assert(result.length === 2 && result[0].text === '[zh-CN] Hello' &&
        observed.authorization === 'Bearer unit-test-token' &&
        observed.userAgent.startsWith('LyricGlance/0.9.0') &&
        observed.body.model === 'custom-translation-model' &&
        observed.body.store === false &&
        observed.body.reasoning?.effort === 'none' &&
        observed.body.text.format.type === 'json_schema' &&
        observed.body.text.format.strict === true &&
        !JSON.stringify(observed.body).includes('unit-test-token'),
    'the OpenAI provider should use authenticated strict structured output without putting the credential in JSON');
    provider.destroy();

    mode = 'alias-success';
    provider = new OpenAITranslationProvider({endpoint});
    result = await translate(provider);
    assert(result.length === 2 && result[0].lineId === lyrics.lines[0].lineId &&
        result[0].text === '[zh-CN] Hello',
    'the observed translations array alias must retain strict ID alignment');
    await provider.checkConnection('unit-test-token', null);
    for (const failure of ['alias-unknown-id', 'alias-duplicate', 'alias-partial',
        'alias-blank', 'alias-conflict']) {
        mode = failure;
        await expectCode(() => translate(provider), 'invalid_response',
            `${failure} must not bypass translation validation`);
    }
    provider.destroy();
    mode = 'success';

    provider = new OpenAITranslationProvider({endpoint});
    try {
        for (const [failure, reason] of [
            ['missing-output', 'missing_output'],
            ['missing-text', 'missing_output_text'],
            ['invalid-translation-json', 'translation_json'],
            ['incomplete', 'output_limit'],
        ]) {
            mode = failure;
            await expectCode(() => translate(provider), 'invalid_response',
                `${failure} must be rejected even when HTTP succeeds`);
            assert(diagnostics.at(-1) === `LyricGlance: invalid translation response reason=${reason}`,
                'invalid response diagnostics must retain only a fixed classification');
        }
        assert(!diagnostics.join('\n').includes('private-response-content') &&
            !diagnostics.join('\n').includes('unit-test-token') &&
            !diagnostics.join('\n').includes(lyrics.lines[0].lineId),
        'response diagnostics must not expose credentials, response text or line IDs');
    } finally {
        provider.destroy();
    }
    mode = 'success';

    const cacheRoot = GLib.dir_make_tmp('lyric-mixed-translation-XXXXXX');
    provider = new OpenAITranslationProvider({endpoint});
    const mixedService = new TranslationService({
        providers: [provider],
        credentialStore: {lookup: async () => 'unit-test-token'},
        cache: new TranslationDiskCache({cacheRoot}),
    });
    const mixedOptions = {trackKey: 'mixed-track', providerId: provider.id,
        targetLanguage: 'zh-CN'};
    try {
        // Before prompt versioning, endpoint alone identified this cache.
        const oldCache = new TranslationDiskCache({cacheRoot});
        await oldCache.put(createTranslationDocument({
            trackKey: mixedOptions.trackKey,
            sourceLyricsHash: sourceLyricsHash(mixedLyrics),
            sourceLanguage: 'ja', targetLanguage: mixedOptions.targetLanguage,
            provider: provider.id, model: provider.model,
            providerConfiguration: GLib.compute_checksum_for_string(
                GLib.ChecksumType.SHA256, endpoint, -1),
            lines: mixedLyrics.lines.map(line => ({lineId: line.lineId, text: line.text})),
        }));
        for (const failure of ['mixed-partial', 'mixed-blank']) {
            mode = failure;
            const beforeMixed = requestCount;
            result = await mixedService.translate(mixedLyrics, mixedOptions);
            assert(result.status === TranslationStatus.INVALID_RESPONSE &&
                requestCount === beforeMixed + 1,
            'old prompt caches must not hide an omitted or empty English translation');
        }
        mode = 'mixed';
        result = await mixedService.translate(mixedLyrics, mixedOptions);
        const input = JSON.parse(observed.body.input);
        assert(result.status === TranslationStatus.AVAILABLE && !result.fromCache &&
            input.sourceLanguage === 'ja' && input.targetLanguage === 'zh-CN' &&
            input.lines.map(line => line.text).join('\n') ===
                mixedLyrics.lines.map(line => line.text).join('\n') &&
            result.document.lines.map(line => line.text).join('\n') === mixedTranslations.join('\n'),
        'Japanese, English, mixed phrases and target-language text must all survive the request/response path');
        const afterMixed = requestCount;
        result = await mixedService.translate(mixedLyrics, mixedOptions);
        assert(result.fromCache && requestCount === afterMixed,
            'translations generated with the current prompt must still use the cache');
    } finally {
        mixedService.destroy();
        await removeTree(Gio.File.new_for_path(cacheRoot));
    }
    mode = 'success';

    mode = 'reject-reasoning';
    requestCount = 0;
    provider = new OpenAITranslationProvider({endpoint});
    const concurrent = await Promise.allSettled([0, 1, 2].map(() => translate(provider)));
    assert(concurrent.every(result => result.status === 'fulfilled') && requestCount === 6,
        'all three in-flight requests must independently retry a confirmed unsupported reasoning parameter');
    provider.destroy();

    mode = 'http-error';
    for (const [status, error, expected] of [
        [401, {}, 'authentication_error'],
        [403, {}, 'permission_denied'],
        [403, {code: 'invalid_api_key'}, 'authentication_error'],
        [403, {code: 'insufficient_quota'}, 'quota_exceeded'],
        [429, {type: 'insufficient_quota'}, 'quota_exceeded'],
        [429, {code: 'credit_balance_exhausted'}, 'quota_exceeded'],
        [400, {param: 'model', code: 'model_not_found'}, 'provider_error'],
        [400, {param: 'reasoning', code: 'required_parameter'}, 'provider_error'],
    ]) {
        requestCount = 0;
        httpError = {status, error: {...error, message: 'sensitive provider error text'}};
        provider = new OpenAITranslationProvider({endpoint});
        await expectCode(() => translate(provider), expected, `HTTP ${status} must retain ${expected}`);
        assert(requestCount === 1, 'quota and unrelated request errors must not be retried');
        if (status === 400) {
            mode = 'success';
            await translate(provider);
            assert(observed.body.reasoning?.effort === 'none',
                'unrelated 400 errors must not disable reasoning for later requests');
            mode = 'http-error';
        }
        provider.destroy();
    }
    for (const body of ['<html>forbidden</html>', 'x'.repeat(20_000)]) {
        httpError = {status: 403, body};
        provider = new OpenAITranslationProvider({endpoint});
        await expectCode(() => translate(provider), 'permission_denied',
            'unparseable or oversized error bodies must retain safe HTTP classification');
        provider.destroy();
    }

    mode = 'reject-reasoning';
    provider = new OpenAITranslationProvider({endpoint, model: 'plain-model'});
    const beforeFallback = requestCount;
    result = await translate(provider);
    assert(result.length === 2 && requestCount === beforeFallback + 2 &&
        !Object.hasOwn(observed.body, 'reasoning'),
    'models rejecting the reasoning parameter should be retried once without it');
    await translate(provider);
    assert(requestCount === beforeFallback + 3,
        'the reasoning fallback should be remembered by the provider');
    provider.destroy();
    mode = 'success';

    provider = new OpenAITranslationProvider({endpoint, model: 'connection-test-model'});
    await provider.checkConnection('connection-test-token', null);
    const probe = JSON.parse(observed.body.input);
    assert(observed.body.model === 'connection-test-model' &&
        observed.authorization === 'Bearer connection-test-token' &&
        observed.body.max_output_tokens === 512 &&
        probe.lines.length === 1 && probe.lines[0].text === 'Hello' &&
        probe.title === '' && probe.artist === '' && observed.body.store === false,
    'connection checks must validate the configured model with a small synthetic request');
    for (const failure of ['empty', 'blank', 'malformed', 'unknown-id']) {
        mode = failure;
        await expectCode(() => provider.checkConnection('connection-test-token', null),
            'invalid_response', `${failure} must not count as a successful connection`);
    }
    mode = 'authentication';
    await expectCode(() => provider.checkConnection('connection-test-token', null),
        'authentication_error', 'connection checks must report rejected credentials');
    const canceled = new Gio.Cancellable();
    canceled.cancel();
    const beforeCancel = requestCount;
    await expectCode(() => provider.checkConnection('connection-test-token', canceled),
        'canceled', 'canceled checks must stop without sending a request');
    assert(requestCount === beforeCancel, 'cancellation must not contact the API');
    mode = 'success';
    cancelDuringRequest = new Gio.Cancellable();
    await expectCode(() => provider.checkConnection('connection-test-token', cancelDuringRequest),
        'canceled', 'an in-flight connection check must honor cancellation');
    assert(requestCount === beforeCancel + 1,
        'the in-flight cancellation check must reach the server before cancellation');
    cancelDuringRequest = null;
    provider.destroy();
    mode = 'success';

    provider = new OpenAITranslationProvider({
        endpoint: 'not a URL',
    });
    await expectCode(() => translate(provider), 'provider_error',
        'an invalid configured endpoint should fail without a network request');
    provider.destroy();

    provider = new OpenAITranslationProvider({endpoint, model: '   '});
    await expectCode(() => translate(provider), 'provider_error',
        'an empty configured model should fail without a network request');
    provider.destroy();

    provider = new OpenAITranslationProvider({
        endpoint,
        maxResponseBytes: 64,
    });
    await expectCode(() => translate(provider), 'invalid_response',
        'an oversized translation response should be rejected');
    provider.destroy();

    mode = 'redirect';
    requestCount = 0;
    provider = new OpenAITranslationProvider({endpoint});
    await expectCode(() => translate(provider), 'provider_error',
        'redirects should be rejected instead of forwarding translation data');
    assert(requestCount === 1,
        'the translation provider should not follow redirects');
    provider.destroy();

    mode = 'malformed';
    provider = new OpenAITranslationProvider({endpoint});
    await expectCode(() => translate(provider), 'invalid_response',
        'malformed JSON should be reported as an invalid response');
    provider.destroy();

    mode = 'unknown-id';
    provider = new OpenAITranslationProvider({endpoint});
    await expectCode(() => translate(provider), 'invalid_response',
        'unknown returned IDs should be rejected');
    provider.destroy();

    mode = 'authentication';
    provider = new OpenAITranslationProvider({endpoint});
    await expectCode(() => translate(provider), 'authentication_error',
        'bad credentials should have a distinct status');
    provider.destroy();

    mode = 'rate-limit';
    requestCount = 0;
    const started = GLib.get_monotonic_time();
    provider = new OpenAITranslationProvider({endpoint});
    result = await translate(provider);
    const elapsedMs = (GLib.get_monotonic_time() - started) / 1000;
    assert(result.length === 2 && requestCount === 2 && elapsedMs >= 900,
        'HTTP 429 should respect Retry-After and retry only after a delay');
    provider.destroy();

    // Cancel only after the real retry source has been armed.
    mode = 'rate-limit';
    requestCount = 0;
    const backoffCancellable = new Gio.Cancellable();
    const backoffTimeoutAdd = GLib.timeout_add;
    let backoffTimerId = 0;
    let cancelBackoffIdleId = 0;
    GLib.timeout_add = (priority, milliseconds, callback) => {
        backoffTimerId = backoffTimeoutAdd(priority, milliseconds, callback);
        cancelBackoffIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            cancelBackoffIdleId = 0;
            backoffCancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        return backoffTimerId;
    };
    provider = new OpenAITranslationProvider({endpoint});
    try {
        await expectCode(() => provider.checkConnection('connection-test-token', backoffCancellable),
            'canceled', 'canceling during Retry-After must finish without deadlocking the main loop');
        assert(backoffTimerId !== 0 && requestCount === 1 &&
            GLib.MainContext.default().find_source_by_id(backoffTimerId) === null,
        'canceling an armed backoff must remove its timer and prevent a second request');
    } finally {
        GLib.timeout_add = backoffTimeoutAdd;
        if (cancelBackoffIdleId)
            GLib.source_remove(cancelBackoffIdleId);
        provider.destroy();
    }

    // Keep boundary tests fast while observing whether a retry was scheduled.
    const originalTimeoutAdd = GLib.timeout_add;
    const retryTimers = [];
    GLib.timeout_add = (priority, milliseconds, callback) => {
        retryTimers.push(milliseconds);
        return originalTimeoutAdd(priority, 1, callback);
    };
    try {
        for (const [header, timeoutSeconds, shouldRetry] of [
            ['5000000', 120, false],
            ['3600', 15, false],
            ['31', 120, false],
            ['30', 120, true],
            ['16', 15, false],
            ['15', 15, true],
            ['31', 0, false],
            ['30', 0, true],
            ['1e308', 120, false],
            [new Date(Date.now() + 3_600_000).toUTCString(), 15, false],
        ]) {
            mode = 'rate-limit';
            retryAfter = header;
            requestCount = 0;
            retryTimers.length = 0;
            provider = new OpenAITranslationProvider({endpoint, timeoutSeconds});
            try {
                if (shouldRetry) {
                    await provider.checkConnection('connection-test-token', null);
                    assert(requestCount === 2 && retryTimers.length === 1 &&
                        retryTimers[0] === Number(header) * 1000,
                    'Retry-After at the allowed limit must be respected with one retry');
                } else {
                    await expectCode(() => provider.checkConnection('connection-test-token', null),
                        'rate_limited', `${header}: excessive Retry-After must remain rate_limited`);
                    assert(requestCount === 1 && retryTimers.length === 0,
                        `${header}: excessive Retry-After must not start a timer or another request`);
                }
            } finally {
                provider.destroy();
            }
        }
    } finally {
        GLib.timeout_add = originalTimeoutAdd;
        retryAfter = '0';
    }

    mode = 'slow';
    requestCount = 0;
    provider = new OpenAITranslationProvider({endpoint, timeoutSeconds: 1});
    try {
        let failure;
        try {
            await translate(provider);
        } catch (error) {
            failure = error;
        }
        assert(failure?.code === 'network_error' && failure.networkReason === 'timeout' &&
            requestCount === 1, 'a slow real HTTP response must be classified without automatic retry');
    } finally {
        provider.destroy();
    }
    // Let the paused server response finish before disconnecting the fixture.
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2100, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

const loop = new GLib.MainLoop(null, false);
let scenarioError = null;
run().catch(error => (scenarioError = error)).finally(() => loop.quit());
loop.run();
server.disconnect();
if (scenarioError)
    throw scenarioError;

print('OpenAI translation HTTP contract, errors and 429 tests passed');
