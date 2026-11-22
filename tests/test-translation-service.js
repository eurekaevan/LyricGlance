import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret?version=1';

import {createLyricsDocument} from '../lyrics-document.js';
import {removeTree, trackKey} from '../storage.js';
import {countTranslationCache, TranslationDiskCache} from '../translation-cache.js';
import {TranslationProviderError} from '../translation-provider.js';

class MockTranslationProvider {
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
        if (this.delayMs > 0) {
            let timerId = 0;
            let signalId = 0;
            try {
                await new Promise(resolve => {
                    timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.delayMs, () => {
                        timerId = 0;
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                    signalId = cancellable?.connect(resolve) ?? 0;
                });
            } finally {
                if (timerId)
                    GLib.source_remove(timerId);
                if (signalId)
                    cancellable.disconnect(signalId);
            }
        }
        if (cancellable?.is_cancelled())
            throw new TranslationProviderError('canceled', 'Translation canceled');
        return options.chunk.lines.map(line => ({
            lineId: line.id,
            text: `[${options.targetLanguage}] ${line.text}`,
        }));
    }

    destroy() {}
}

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const tempRoot = GLib.dir_make_tmp('lyric-glance-translation-XXXXXX');
const track = {
    title: 'Translation Test',
    artist: 'Fixture Artist',
    album: 'Fixture Album',
    durationUs: 180_000_000,
};

function lyricsDocument({language = 'en', lineCount = 3, instrumental = false} = {}) {
    return createLyricsDocument({
        source: 'test',
        instrumental,
        metadata: {...track, language},
        lines: instrumental ? [] : Array.from({length: lineCount}, (_v, index) => ({
            text: `Line ${index + 1}`,
            startMs: index * 1000,
            endMs: (index + 1) * 1000,
        })),
    });
}

function options(overrides = {}) {
    return {
        trackKey: trackKey(track),
        targetLanguage: 'zh-CN',
        providerId: 'mock',
        ...overrides,
    };
}

const noCredential = {lookup: async () => null};

async function run() {
    // Observe allocations before importing the service and its static dependencies.
    const originalSchema = Secret.Schema;
    const originalSplit = String.prototype.split;
    let schemasCreated = 0;
    let modelsExpanded = 0;
    let serviceModule;
    try {
        Secret.Schema = new Proxy(originalSchema, {
            construct(target, args) {
                schemasCreated++;
                return new target(...args);
            },
        });
        String.prototype.split = function (separator, limit) {
            if (separator === '|')
                modelsExpanded++;
            return originalSplit.call(this, separator, limit);
        };
        serviceModule = await import('../translation-service.js');
        const {isValidCredential, TranslationCredentialStore} = await import('../credentials.js');
        const credentialStore = new TranslationCredentialStore();
        assert(schemasCreated === 0 && modelsExpanded === 0,
            'importing translation modules and constructing a credential store must not allocate a schema or expand language models');
        assert(isValidCredential('sk-test_123') &&
            !isValidCredential('sk-line1\r\nsk-line2') &&
            !isValidCredential('sk-line1\nsk-line2') &&
            !isValidCredential('sk-has space') &&
            !isValidCredential('sk-中文key'),
        'credential validation must reject control characters, embedded whitespace and non-ASCII');
        await credentialStore.store('lifecycle-test', 'bad\r\nkey').then(
            () => assert(false, 'invalid credential characters must be rejected before storing'),
            error => assert(error.message === 'API credential contains invalid characters',
                'invalid credential errors must not leak the rejected key'));
        const cancelled = new Gio.Cancellable();
        cancelled.cancel();
        for (const store of [credentialStore, credentialStore, new TranslationCredentialStore()]) {
            await store.lookup('lifecycle-test', cancelled).then(
                () => assert(false, 'a cancelled credential lookup must fail'),
                error => assert(error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED),
                    'a cancelled credential lookup must preserve CANCELLED classification'));
            assert(schemasCreated === (store === credentialStore ? 1 : 2),
                'schemas must be created on first use and reused only within their owning store');
        }
        assert(serviceModule.sourceLyricsLanguage({metadata: {language: 'en'}}) === 'en' &&
            serviceModule.sourceLyricsLanguage({lines: [{text: 'Hello world'}]}) === 'unknown' &&
            modelsExpanded === 0,
        'explicit languages and insufficient samples must not expand language models');
        const {francAll} = await import('../franc.mjs');
        assert(francAll('')[0][0] === 'und' && modelsExpanded === 0,
            'franc must reject empty input without expanding its models');
        const text = 'Every morning we open the windows and listen to the quiet sounds outside.';
        const first = francAll(text);
        const expanded = modelsExpanded;
        assert(expanded > 0 && JSON.stringify(francAll(text)) === JSON.stringify(first) &&
            modelsExpanded === expanded,
        'the first detection must expand models once and subsequent detections must reuse them');
    } finally {
        Secret.Schema = originalSchema;
        String.prototype.split = originalSplit;
    }
    const {
        languagesEquivalent,
        sourceLyricsLanguage,
        TranslationService,
        TranslationStatus,
    } = serviceModule;

    assert(languagesEquivalent('zh', 'zh-CN') &&
        languagesEquivalent('en-US', 'en') &&
        languagesEquivalent(' ZH_cn ', 'zh-CN') &&
        !languagesEquivalent('unknown', 'zh-CN') &&
        !languagesEquivalent('ja', 'zh-CN'),
    'same-language skipping should only use explicit language codes');
    assert(languagesEquivalent('eng', 'en-US') && languagesEquivalent('cmn', 'zh_CN') &&
        !languagesEquivalent('und', 'und'),
        'detector ISO language codes must match locale codes without treating unknown as a language');
    const languageSamples = {
        en: 'Every morning we open the windows and listen to the quiet sounds outside. We walk together through the city and talk about the things we hope to do tomorrow. The road is long but we have enough time to find our way home.',
        zh: '清晨我们推开窗户，听见远处传来清脆的鸟鸣。我们沿着熟悉的小路走向河边，看见阳光洒在水面上。无论明天会遇到什么困难，我们都会记住今天的约定，带着希望继续向前走，把这些温暖的回忆留在心里。',
        ja: '朝になったら窓を開けて、遠くから聞こえる鳥の声を聞きます。私たちはいつもの道を歩きながら、明日のことを話しています。どんなことがあっても、この気持ちを忘れないで、一緒に前へ進んでいきたいと思います。',
        fr: 'Chaque matin nous ouvrons les fenêtres pour écouter les oiseaux dans le jardin. Nous marchons ensemble dans les rues et nous parlons de ce que nous voulons faire demain. Même si le chemin est long, nous pouvons toujours trouver une nouvelle raison de continuer.',
    };
    for (const [language, text] of Object.entries(languageSamples)) {
        assert(sourceLyricsLanguage({lines: [{text}]}) === language,
            `unmarked ${language} text should be identified offline`);
    }
    assert(sourceLyricsLanguage({lines: [{text: 'Hello world'}]}) === 'unknown' &&
        sourceLyricsLanguage({lines: Array(100).fill({text: 'Hello world'})}) === 'unknown' &&
        sourceLyricsLanguage({lines: [{text: languageSamples.en}, {text: languageSamples.zh}]}) === 'unknown' &&
        sourceLyricsLanguage({lines: [{text: languageSamples.en}, {text: languageSamples.fr}]}) === 'unknown',
        'short/repeated samples and mixed languages must not cause an automatic skip');
    assert(sourceLyricsLanguage({metadata: {language: 'ja'}, lines: [{text: languageSamples.zh}]}) === 'ja',
        'explicit source language takes priority over statistical detection');
    assert(sourceLyricsLanguage({lines: [
        {text: '爱の初体验故事的小黄花从出生那年就飘着童年的荡秋千随记忆一直晃到现在'},
        {text: '吹着前奏望着天空我想起花瓣试着掉落为你翘课的那一天花落的那一天'},
        {text: '心の世界教室的那一间我怎么看不见消失的下雨天我好想再淋一遍'},
        {text: '没想到失去的勇气我还留着好想再问一遍你会等待还是离开刮风这天我试过握着你手'},
    ]}) === 'zh', 'Chinese lyrics with stylized の must not be misclassified as Japanese');
    assert(sourceLyricsLanguage({lines: [
        {text: 'Producer: Jay Chou / Mixing: Gary Yang'},
        {text: '故事的小黄花从出生那年就飘着童年的荡秋千随记忆一直晃到现在'},
        {text: '吹着前奏望着天空我想起花瓣试着掉落为你翘课的那一天花落的那一天'},
        {text: '教室的那一间我怎么看不见消失的下雨天我好想再淋一遍'},
        {text: '没想到失去的勇气我还留着好想再问一遍你会等待还是离开'},
    ]}) === 'zh', 'credit lines with English names must not prevent same-language skipping');
    assert(sourceLyricsLanguage({lines: [
        {text: '故事的小黄花从出生那年就飘着童年的荡秋千随记忆一直晃到现在'},
        {text: '吹着前奏望着天空我想起花瓣试着掉落为你翘课的那一天花落的那一天'},
        {text: '教室的那一间我怎么看不见消失的下雨天'},
    ]}) === 'zh', 'concise Chinese lyrics (>= 60 Han chars) should be detected offline');
    assert(sourceLyricsLanguage({lines: [
        {text: '春风吹过山野，花开花落，时光流转不息。'},
        {text: '   ...   ---   !!!   '},
        {text: '明月照亮长夜星河璀璨歌声回荡在远方山谷之间倾听风声'},
        {text: '岁月如歌记忆长存心中永不褪色思念随风飘向天际海角'},
    ]}) === 'zh', 'concise Chinese lyrics with uneven punctuation should still be detected offline');

    const cache = new TranslationDiskCache({cacheRoot: tempRoot});
    const provider = new MockTranslationProvider();
    const service = new TranslationService({
        providers: [provider],
        credentialStore: noCredential,
        cache,
    });
    const lyrics = lyricsDocument();
    let result = await service.translate(lyrics, options());
    assert(result.status === TranslationStatus.AVAILABLE &&
        !result.fromCache && provider.requestCount === 1 &&
        result.document.lines.find(line => line.lineId === lyrics.lines[0].lineId)?.text === '[zh-CN] Line 1',
    'the mock provider should translate a complete song once');
    const cachedTranslation = result.document;

    const secondProvider = new MockTranslationProvider();
    const secondService = new TranslationService({
        providers: [secondProvider],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({cacheRoot: tempRoot}),
    });
    result = await secondService.translate(lyrics, options());
    assert(result.status === TranslationStatus.AVAILABLE &&
        result.fromCache && secondProvider.requestCount === 0,
    'translation cache should survive service recreation');

    const cachedPath = cache._fileFor(result.document).get_path();
    const [cachedOk, cachedBytes] = GLib.file_get_contents(cachedPath);
    assert(cachedOk, 'the translation cache record should be readable');
    const staleRecord = JSON.parse(
        new TextDecoder().decode(cachedBytes));
    staleRecord.version = 0;
    GLib.file_set_contents(cachedPath, JSON.stringify(staleRecord));
    const stale = await cache.get(result.document, trackKey(track));
    assert(!stale.hit,
        'a mismatched translation cache schema version should be a safe miss');

    result = await secondService.translate(lyrics, options({
        forceRefresh: true,
    }));
    assert(!result.fromCache && secondProvider.requestCount === 1,
        'manual refresh should bypass and overwrite a cached translation');

    result = await secondService.translate(lyrics, options({
        targetLanguage: 'ja',
    }));
    assert(!result.fromCache && secondProvider.requestCount === 2,
        'target language changes should miss the translation cache');

    const changedLyrics = createLyricsDocument({
        source: 'test',
        metadata: {...track, language: 'en'},
        lines: [{text: 'Changed source', startMs: 0, endMs: 1000}],
    });
    await secondService.translate(changedLyrics, options());
    assert(secondProvider.requestCount === 3,
        'source lyrics changes should miss the translation cache');

    const alternate = new MockTranslationProvider({id: 'other'});
    const providerService = new TranslationService({
        providers: [alternate],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({cacheRoot: tempRoot}),
    });
    result = await providerService.translate(lyrics, options({
        providerId: 'other',
    }));
    assert(!result.fromCache && alternate.requestCount === 1,
    'provider changes should miss the translation cache');

    const alternateEndpoint = new MockTranslationProvider({
        configurationId: 'mock-endpoint-b',
    });
    const alternateEndpointService = new TranslationService({
        providers: [alternateEndpoint],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({cacheRoot: tempRoot}),
    });
    result = await alternateEndpointService.translate(lyrics, options());
    assert(!result.fromCache && alternateEndpoint.requestCount === 1,
        'different provider endpoints should not share cached translations');

    const refreshDisk = new TranslationDiskCache({
        cacheRoot: GLib.build_filenamev([tempRoot, 'refresh-in-flight']),
    });
    await refreshDisk.put(cachedTranslation);
    const refreshProvider = new MockTranslationProvider();
    const refreshTranslate = refreshProvider.translate.bind(refreshProvider);
    refreshProvider.translate = async (...args) => (await refreshTranslate(...args))
        .map(line => ({...line, text: `Fresh ${line.text}`}));
    const refreshService = new TranslationService({
        providers: [refreshProvider], credentialStore: noCredential, cache: refreshDisk,
    });
    const readCached = refreshDisk.get.bind(refreshDisk);
    let releaseCachedRead;
    let cachedReadStarted;
    const cachedReadBlocked = new Promise(resolve => (releaseCachedRead = resolve));
    const cachedReadReady = new Promise(resolve => (cachedReadStarted = resolve));
    refreshDisk.get = async (...args) => {
        const hit = await readCached(...args);
        assert(hit.hit, 'the refresh race must start with a real cached translation');
        cachedReadStarted();
        await cachedReadBlocked;
        return hit;
    };
    const ordinaryRead = refreshService.translate(lyrics, options());
    await cachedReadReady;
    try {
        const forced = refreshService.translate(lyrics, options({forceRefresh: true}));
        assert(forced !== ordinaryRead,
            'a forced refresh must not reuse an in-flight ordinary cache read');
        assert(forced === refreshService.translate(lyrics, options({forceRefresh: true})) &&
            forced === refreshService.translate(lyrics, options()),
        'equivalent callers should join the pending forced refresh instead of duplicating it');
        const fresh = await forced;
        assert(fresh.status === TranslationStatus.AVAILABLE && !fresh.fromCache &&
            refreshProvider.requestCount === 1 && fresh.document.lines[0].text.startsWith('Fresh '),
        'refresh must contact the provider once even while a cache hit is waiting');
        releaseCachedRead();
        assert((await ordinaryRead).status === TranslationStatus.CANCELED,
            'the superseded cache read must settle as canceled');
        const remembered = await refreshService.translate(lyrics, options());
        assert(remembered.fromCache && remembered.document === fresh.document &&
            refreshService._inFlight.size === 0,
        'a late superseded cache read must not replace the refreshed memory entry or leak a job');
    } finally {
        releaseCachedRead();
        refreshService.destroy();
        await ordinaryRead;
    }

    const cacheOnlyDisk = new TranslationDiskCache({
        cacheRoot: GLib.build_filenamev([tempRoot, 'cache-only-vs-refresh']),
    });
    await cacheOnlyDisk.put(cachedTranslation);
    const cacheOnlyProvider = new MockTranslationProvider();
    const cacheOnlyBaseTranslate = cacheOnlyProvider.translate.bind(cacheOnlyProvider);
    cacheOnlyProvider.translate = async (...args) => (await cacheOnlyBaseTranslate(...args))
        .map(line => ({...line, text: `Rebuilt ${line.text}`}));
    const cacheOnlyService = new TranslationService({
        providers: [cacheOnlyProvider], credentialStore: noCredential, cache: cacheOnlyDisk,
    });
    const cacheOnlyRawGet = cacheOnlyDisk.get.bind(cacheOnlyDisk);
    let releaseCacheOnly;
    let cacheOnlyStarted;
    const cacheOnlyGate = new Promise(resolve => (releaseCacheOnly = resolve));
    const cacheOnlyReady = new Promise(resolve => (cacheOnlyStarted = resolve));
    cacheOnlyDisk.get = async (...args) => {
        const hit = await cacheOnlyRawGet(...args);
        cacheOnlyStarted();
        await cacheOnlyGate;
        return hit;
    };
    const pendingCacheOnly = cacheOnlyService.translate(lyrics, options({allowNetwork: false}));
    await cacheOnlyReady;
    try {
        const forcedNet = cacheOnlyService.translate(lyrics, options({forceRefresh: true}));
        const freshResult = await forcedNet;
        releaseCacheOnly();
        assert((await pendingCacheOnly).status === TranslationStatus.CANCELED &&
            freshResult.status === TranslationStatus.AVAILABLE &&
            freshResult.document.lines[0].text.startsWith('Rebuilt '),
        'forceRefresh must cancel an overlapping cache-only disk read for the same track');
        const memCheck = await cacheOnlyService.translate(lyrics, options({allowNetwork: false}));
        assert(memCheck.document === freshResult.document,
            'a canceled cache-only read must not overwrite the refreshed memory entry');
    } finally {
        releaseCacheOnly();
        cacheOnlyService.destroy();
        await pendingCacheOnly;
    }

    const delayed = new MockTranslationProvider({delayMs: 100});
    const dedupService = new TranslationService({
        providers: [delayed],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'dedup']),
        }),
    });
    const firstStatuses = [];
    const duplicateStatuses = [];
    const lateStatuses = [];
    let reportLoading;
    const loading = new Promise(resolve => (reportLoading = resolve));
    const first = dedupService.translate(lyrics, options({onStatus: value => {
        firstStatuses.push(value.status);
        if (value.status === TranslationStatus.LOADING)
            reportLoading();
    }}));
    const duplicate = dedupService.translate(lyrics, options({
        onStatus: value => duplicateStatuses.push(value.status),
    }));
    assert(first === duplicate,
        'identical translation calls should await the same promise');
    await loading;
    const late = dedupService.translate(lyrics, options({
        onStatus: value => lateStatuses.push(value.status),
    }));
    assert(late === first && lateStatuses.join() === TranslationStatus.LOADING,
        'a caller joining after loading must immediately receive the current status');
    await Promise.all([first, duplicate, late]);
    assert(delayed.requestCount === 1,
        'request deduplication should consume one provider request');
    for (const statuses of [firstStatuses, duplicateStatuses, lateStatuses])
        assert(statuses.join() === [TranslationStatus.LOADING, TranslationStatus.AVAILABLE].join(),
            'every joined caller must receive loading and completion exactly once');

    let reportNetworkStarted;
    const networkStarted = new Promise(resolve => (reportNetworkStarted = resolve));
    const requestsBeforeRefresh = delayed.requestCount;
    const ordinaryNetwork = dedupService.translate(lyrics, options({targetLanguage: 'ja',
        onStatus: value => {
            if (value.status === TranslationStatus.LOADING)
                reportNetworkStarted();
        }}));
    await networkStarted;
    const forcedNetwork = dedupService.translate(lyrics,
        options({targetLanguage: 'ja', forceRefresh: true}));
    assert(forcedNetwork !== ordinaryNetwork,
        'force refresh must supersede ordinary provider work as well as cache reads');
    const [oldNetwork, freshNetwork] = await Promise.all([ordinaryNetwork, forcedNetwork]);
    assert(oldNetwork.status === TranslationStatus.CANCELED &&
        freshNetwork.status === TranslationStatus.AVAILABLE && !freshNetwork.fromCache &&
        delayed.requestCount === requestsBeforeRefresh + 2 && dedupService._inFlight.size === 0,
    'the superseded network job must cancel without deleting its successful forced replacement');

    const cancelProvider = new MockTranslationProvider({delayMs: 500});
    const cancelService = new TranslationService({
        providers: [cancelProvider],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'cancel']),
        }),
    });
    const canceledStatuses = [];
    const canceledDuplicateStatuses = [];
    const canceledPromise = cancelService.translate(lyrics, options({
        onStatus: value => canceledStatuses.push(value.status),
    }));
    assert(canceledPromise === cancelService.translate(lyrics, options({
        onStatus: value => canceledDuplicateStatuses.push(value.status),
    })), 'cancellation subscribers must join the same work');
    cancelService.cancelAll();
    const replacement = cancelService.translate(lyrics, options());
    assert(replacement !== canceledPromise,
        'a new caller must not join an already canceled in-flight promise');
    result = await canceledPromise;
    assert(result.status === TranslationStatus.CANCELED &&
        canceledStatuses.at(-1) === TranslationStatus.CANCELED &&
        canceledDuplicateStatuses.at(-1) === TranslationStatus.CANCELED,
    'track changes should cancel stale translation work and notify every subscriber');
    assert((await replacement).status === TranslationStatus.AVAILABLE,
        'completion of canceled work must not remove or cancel its replacement');

    const requestsBeforeSkip = provider.requestCount;
    result = await service.translate(lyricsDocument({instrumental: true}),
        options({forceRefresh: true}));
    assert(result.status === TranslationStatus.SKIPPED &&
        provider.requestCount === requestsBeforeSkip,
        'instrumental tracks must not call a translation provider');
    result = await service.translate(lyricsDocument({language: 'zh'}),
        options({forceRefresh: true}));
    assert(result.status === TranslationStatus.SAME_LANGUAGE &&
        provider.requestCount === requestsBeforeSkip,
        'explicit equivalent source and target languages should skip translation');
    result = await service.translate(lyricsDocument({language: 'zh'}),
        options({ignoreSameLanguage: true, forceRefresh: true}));
    assert(result.status === TranslationStatus.AVAILABLE &&
        provider.requestCount === requestsBeforeSkip + 1,
        'explicit ignoreSameLanguage override should allow manual translation');
    const requestsAfterOverride = provider.requestCount;
    const symbolOnlyLyrics = createLyricsDocument({
        source: 'test',
        lines: [{text: '♪', startMs: 0, endMs: 1000}, {text: '---', startMs: 1000, endMs: 2000}],
    });
    result = await service.translate(symbolOnlyLyrics, options());
    assert(result.status === TranslationStatus.SKIPPED &&
        provider.requestCount === requestsAfterOverride,
        'symbol-only lyrics should be skipped without contacting the provider');
    const paddedTargetHit = await secondService.translate(lyrics,
        options({targetLanguage: ' zh-CN '}));
    assert(paddedTargetHit.status === TranslationStatus.AVAILABLE && paddedTargetHit.fromCache,
        'target language whitespace should normalize before cache lookup');
    result = await service.translate(lyricsDocument({language: 'zh_CN'}),
        options({providerId: 'not-configured', forceRefresh: true}));
    assert(result.status === TranslationStatus.SAME_LANGUAGE &&
        provider.requestCount === requestsAfterOverride,
    'same-language lyrics must skip translation even without a configured provider');
    const unmarkedLyrics = createLyricsDocument({
        source: 'test',
        lines: [{text: 'Every morning we open the windows and listen to the quiet sounds outside. We walk together through the city and talk about the things we hope to do tomorrow. The road is long but we have enough time to find our way home.'}],
    });
    result = await service.translate(unmarkedLyrics,
        options({targetLanguage: 'en-US', providerId: 'not-configured', forceRefresh: true}));
    assert(result.status === TranslationStatus.SAME_LANGUAGE && provider.requestCount === requestsAfterOverride,
        'confidently identified unmarked lyrics must skip translation without provider configuration');
    result = await service.translate(unmarkedLyrics,
        options({targetLanguage: 'zh-CN', forceRefresh: true}));
    assert(result.status === TranslationStatus.AVAILABLE && provider.requestCount === requestsAfterOverride + 1,
        'identified lyrics in a different language must still be translated');

    const missingModelService = new TranslationService({
        providers: [new MockTranslationProvider({model: ''})],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'missing-model']),
        }),
    });
    result = await missingModelService.translate(lyrics, options());
    assert(result.status === TranslationStatus.PROVIDER_ERROR,
        'an empty model setting should remain a typed provider failure');

    const partialProvider = {
        id: 'partial',
        model: 'partial-v1',
        requiresCredential: false,
        async translate(_document, request) {
            return [{
                lineId: request.chunk.lines[0].id,
                text: 'Partial result',
            }];
        },
    };
    const partialService = new TranslationService({
        providers: [partialProvider],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'partial']),
        }),
    });
    result = await partialService.translate(lyrics, options({
        providerId: 'partial',
    }));
    assert(result.status === TranslationStatus.AVAILABLE &&
        result.document.lines.length === 1,
    `a partial response should keep valid lines and fall back for missing lines: ${result.status}`);

    const invalidProvider = {
        id: 'invalid',
        model: 'invalid-v1',
        requiresCredential: false,
        async translate() {
            return [{lineId: 'unknown', text: 'Wrong line'}];
        },
    };
    const invalidService = new TranslationService({
        providers: [invalidProvider],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'invalid']),
        }),
    });
    result = await invalidService.translate(lyrics, options({
        providerId: 'invalid',
    }));
    assert(result.status === TranslationStatus.INVALID_RESPONSE,
        'malformed provider responses must not crash the translation service');

    for (const code of [
        'authentication_error',
        'permission_denied',
        'quota_exceeded',
        'network_error',
        'provider_error',
        'rate_limited',
    ]) {
        const errorProvider = {
            id: code,
            model: `${code}-v1`,
            requiresCredential: false,
            async translate() {
                const error = new TranslationProviderError(code, 'Safe diagnostic');
                if (code === 'network_error')
                    error.networkReason = 'timeout';
                throw error;
            },
        };
        const errorService = new TranslationService({
            providers: [errorProvider],
            credentialStore: noCredential,
            cache: new TranslationDiskCache({
                cacheRoot: GLib.build_filenamev([tempRoot, code]),
            }),
        });
        result = await errorService.translate(lyrics, options({
            providerId: code,
        }));
        assert(result.status === code,
            `provider failure ${code} should retain its distinct status`);
        if (code === 'network_error')
            assert(result.networkReason === 'timeout', 'network diagnostics must reach the UI result');
        errorService.destroy();
    }

    const completionOrder = [];
    const pendingChunks = [];
    let releaseTimeout = 0;
    const longProvider = {
        id: 'mock',
        model: 'ordered-v1',
        requiresCredential: false,
        requestCount: 0,
        translate(_document, request) {
            this.requestCount++;
            return new Promise((resolve, reject) => {
                pendingChunks.push({request, resolve, reject});
                if (pendingChunks.length === 1) {
                    releaseTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                        releaseTimeout = 0;
                        for (const pending of pendingChunks)
                            pending.reject(new Error('three chunks did not start concurrently'));
                        return GLib.SOURCE_REMOVE;
                    });
                }
                if (pendingChunks.length === 3) {
                    GLib.source_remove(releaseTimeout);
                    releaseTimeout = 0;
                    for (const pending of [...pendingChunks].reverse()) {
                        completionOrder.push(pending.request.chunk.index);
                        pending.resolve(pending.request.chunk.lines.map(line => ({
                            lineId: line.id, text: line.text,
                        })));
                    }
                }
            });
        },
    };
    const longService = new TranslationService({
        providers: [longProvider],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'long']),
        }),
        batchingOptions: {maxLines: 80, maxChars: 100_000},
    });
    const longLyrics = lyricsDocument({lineCount: 205});
    result = await longService.translate(longLyrics, options());
    assert(result.status === TranslationStatus.AVAILABLE &&
        longProvider.requestCount === 3 && completionOrder.join(',') === '2,1,0' &&
        result.document.lines.map(line => line.lineId).join(',') ===
            longLyrics.lines.map(line => line.lineId).join(',') &&
        result.document.lines.every((line, index) => line.text === longLyrics.lines[index].text),
    'chunks completing in reverse order must merge into the exact original lyric order');

    let active = 0;
    let peak = 0;
    let started = 0;
    let siblingCancellations = 0;
    let siblingTimeouts = 0;
    const parallelProvider = {
        id: 'parallel',
        model: 'parallel-v1',
        requiresCredential: false,
        async translate(_document, request, cancellable) {
            started++;
            active++;
            peak = Math.max(peak, active);
            let timerId = 0;
            let signalId = 0;
            try {
                if (request.chunk.index === 1) {
                    await new Promise(resolve => {
                        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
                            timerId = 0;
                            resolve();
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                    const error = new TranslationProviderError('network_error', 'first failure');
                    error.networkReason = 'timeout';
                    throw error;
                }
                await new Promise((_resolve, reject) => {
                    signalId = cancellable.connect(() => {
                        siblingCancellations++;
                        reject(new TranslationProviderError('canceled', 'sibling canceled'));
                    });
                    timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                        timerId = 0;
                        siblingTimeouts++;
                        reject(new Error('sibling request was not canceled promptly'));
                        return GLib.SOURCE_REMOVE;
                    });
                });
            } finally {
                if (timerId)
                    GLib.source_remove(timerId);
                if (signalId)
                    cancellable.disconnect(signalId);
                active--;
            }
        },
    };
    const parallelService = new TranslationService({
        providers: [parallelProvider],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'parallel']),
        }),
        batchingOptions: {maxLines: 10, maxChars: 100_000},
    });
    result = await parallelService.translate(
        lyricsDocument({lineCount: 100}), options({providerId: 'parallel'}));
    assert(result.status === TranslationStatus.NETWORK_ERROR && result.networkReason === 'timeout' &&
        peak > 1 && peak <= 3 && started === 3 && active === 0 &&
        siblingCancellations === 2 && siblingTimeouts === 0,
    `the first failure must cancel both active siblings without replacing its diagnostics or starting more work: ` +
        `${result.status} peak=${peak} started=${started} canceled=${siblingCancellations}`);
    parallelService.destroy();

    const noNetwork = await new TranslationService({
        providers: [new MockTranslationProvider()],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'manual']),
        }),
    }).translate(lyrics, options({allowNetwork: false}));
    assert(noNetwork.status === TranslationStatus.IDLE,
        'auto-translate off should use cache only without a provider request');

    let accessNow = 100;
    const accessCache = new TranslationDiskCache({
        cacheRoot: GLib.build_filenamev([tempRoot, 'access-time']), now: () => accessNow,
    });
    await accessCache.put(cachedTranslation);
    const accessFile = accessCache._fileFor(cachedTranslation);
    const originalAccessReplace = Gio.File.prototype.replace_contents_async;
    let accessWrites = 0;
    Gio.File.prototype.replace_contents_async = function (...args) {
        if (this.equal(accessFile))
            accessWrites++;
        return originalAccessReplace.apply(this, args);
    };
    try {
        for (const elapsed of [1, 12 * 60 * 60 * 1000]) {
            accessNow = 100 + elapsed;
            for (let index = 0; index < 10; index++)
                assert((await accessCache.get(cachedTranslation, 'access-track')).hit,
                    'fresh access metadata must not prevent a disk translation hit');
            await Promise.allSettled([...accessCache._pendingWrites]);
            assert(accessWrites === 0, 'translation reads through twelve hours must not rewrite the song');
        }
        accessNow++;
        await accessCache.get(cachedTranslation, 'access-track');
        await Promise.allSettled([...accessCache._pendingWrites]);
        assert(accessWrites === 1, 'a translation read after twelve hours must refresh access time once');
        await accessCache.get(cachedTranslation, 'access-track');
        await Promise.allSettled([...accessCache._pendingWrites]);
        assert(accessWrites === 1, 'the next translation hit must reuse the refreshed access time');
    } finally {
        Gio.File.prototype.replace_contents_async = originalAccessReplace;
        accessCache.destroy();
    }

    const memoryRoot = GLib.build_filenamev([tempRoot, 'memory']);
    const memoryDisk = new TranslationDiskCache({cacheRoot: memoryRoot});
    const memoryProvider = new MockTranslationProvider();
    const memoryService = new TranslationService({
        providers: [memoryProvider], credentialStore: noCredential, cache: memoryDisk,
    });
    const diskGet = memoryDisk.get.bind(memoryDisk);
    let diskReads = 0;
    memoryDisk.get = (...args) => {
        diskReads++;
        return diskGet(...args);
    };
    await memoryService.translate(lyrics, options());
    const warmReads = diskReads;
    for (let index = 0; index < 20; index++) {
        result = await memoryService.translate(lyrics, options({allowNetwork: false}));
        assert(result.fromCache, 'cache-only requests must reuse a completed translation');
    }
    assert(diskReads === warmReads && memoryProvider.requestCount === 1,
        'twenty warm lookups must add no disk reads or provider requests');
    result = await memoryService.translate(lyrics, options({trackKey: 'other-track'}));
    assert(result.fromCache && result.document.trackKey === 'other-track' &&
        diskReads === warmReads + 1,
    'identical lyrics under a different track key must return a correctly rebound document');
    result = await memoryService.translate(lyrics, options({forceRefresh: true}));
    assert(!result.fromCache && memoryProvider.requestCount === 2 && diskReads === warmReads + 1,
        'manual refresh must bypass both caches and update the completed result');
    result = await memoryService.translate(lyrics, options({forceRefresh: true, allowNetwork: false}));
    assert(result.status === TranslationStatus.IDLE && memoryProvider.requestCount === 2,
        'force refresh without network permission must retain its cache-bypass semantics');
    await memoryService.clearCache();
    const readsBeforeFill = diskReads;
    for (let index = 0; index < 20; index++)
        await memoryService.translate(lyrics, options({trackKey: `lru-${index}`}));
    assert(memoryProvider.requestCount === 3 && diskReads === readsBeforeFill + 20,
        'clearing must invalidate memory and disk while later songs can reuse the new disk entry');
    await memoryService.translate(lyrics, options({trackKey: 'lru-0'}));
    await memoryService.translate(lyrics, options({trackKey: 'lru-20'}));
    const readsAfterOverflow = diskReads;
    await memoryService.translate(lyrics, options({trackKey: 'lru-0'}));
    assert(diskReads === readsAfterOverflow && memoryService._memoryCache.size === 20,
        'a memory hit must refresh recency and retain the twenty-entry bound');
    await memoryService.translate(lyrics, options({trackKey: 'lru-1'}));
    assert(diskReads === readsAfterOverflow + 1,
        'the least recently used translation must fall back to disk after eviction');
    memoryService.destroy();
    assert(memoryService._memoryCache.size === 0, 'destroy must release completed translations');

    for (const [action, phase] of [['clear', 'read'], ['destroy', 'read'],
        ['clear', 'write'], ['destroy', 'write']]) {
        const lateDisk = new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, `late-${phase}-${action}`]),
        });
        await lateDisk.put(cachedTranslation);
        const lateService = new TranslationService({
            providers: [new MockTranslationProvider()], credentialStore: noCredential, cache: lateDisk,
        });
        const method = phase === 'read' ? 'get' : 'put';
        const original = lateDisk[method].bind(lateDisk);
        let releaseRead;
        let readStarted;
        const blocked = new Promise(resolve => (releaseRead = resolve));
        const startedReading = new Promise(resolve => (readStarted = resolve));
        lateDisk[method] = async (...args) => {
            const hit = await original(...args);
            if (phase === 'read')
                assert(hit.hit, 'the delayed read fixture must find a valid disk translation');
            readStarted();
            await blocked;
            return hit;
        };
        const translating = lateService.translate(lyrics, options({forceRefresh: phase === 'write'}));
        await startedReading;
        try {
            if (action === 'clear')
                await lateService.clearCache();
            else
                lateService.destroy();
        } finally {
            releaseRead();
        }
        result = await translating;
        assert(result.status === TranslationStatus.CANCELED && lateService._memoryCache.size === 0,
            `${action} must prevent a delayed ${phase} from refilling the memory cache`);
        lateService.destroy();
    }

    for (const action of ['clear', 'destroy', 'put-cancel', 'put-destroy']) {
        let accessedAt = 100;
        const lifecycleRoot = GLib.build_filenamev([tempRoot, action]);
        const lifecycleCache = new TranslationDiskCache({
            cacheRoot: lifecycleRoot,
            now: () => accessedAt,
        });
        const lifecycleService = new TranslationService({
            providers: [new MockTranslationProvider()],
            credentialStore: noCredential,
            cache: lifecycleCache,
        });
        await lifecycleCache.put(cachedTranslation);
        accessedAt += 12 * 60 * 60 * 1000 + 1;
        const file = lifecycleCache._fileFor(cachedTranslation);
        const originalReplace = Gio.File.prototype.replace_contents_async;
        const originalEnumerate = Gio.File.prototype.enumerate_children_async;
        let deletionStarted = false;
        let releaseWrite;
        let writeStarted;
        let writeCancellable;
        const blocked = new Promise(resolve => (releaseWrite = resolve));
        const startedWriting = new Promise(resolve => (writeStarted = resolve));
        Gio.File.prototype.replace_contents_async = async function (...args) {
            if (this.equal(file)) {
                writeCancellable = args.at(-1);
                writeStarted();
                await blocked;
            }
            return originalReplace.apply(this, args);
        };
        Gio.File.prototype.enumerate_children_async = function (...args) {
            if (this.equal(file.get_parent()))
                deletionStarted = true;
            return originalEnumerate.apply(this, args);
        };
        try {
            const requestCancellable = new Gio.Cancellable();
            if (action.startsWith('put-')) {
                lifecycleCache.put(cachedTranslation,
                    action === 'put-cancel' ? requestCancellable : null).catch(() => {});
            } else {
                const hit = await lifecycleService.translate(lyrics, options());
                assert(hit.fromCache && lifecycleService._inFlight.size === 0,
                    'cache hits should return while the access-time write is still pending');
            }
            await startedWriting;
            const pending = [...lifecycleCache._pendingWrites];
            assert(pending.length === 1, 'every cache write must remain tracked until it settles');
            if (action === 'clear') {
                const clearing = lifecycleService.clearCache();
                assert(!deletionStarted,
                    'clearing must wait for the pending access-time write before starting deletion');
                releaseWrite();
                await clearing;
                assert(await countTranslationCache(lifecycleRoot) === 0 &&
                    !file.query_exists(null),
                'the delayed access-time write must not recreate a cleared entry');
            } else {
                if (action === 'put-cancel')
                    requestCancellable.cancel();
                else
                    lifecycleService.destroy();
                assert(writeCancellable.is_cancelled(),
                    'destroy and request cancellation must cancel their owned writes');
                releaseWrite();
                const settled = await Promise.allSettled(pending);
                assert(settled.every(entry => entry.status === 'rejected' &&
                    entry.reason.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)),
                'canceled writes must settle as canceled rather than writing after destruction');
                const [, bytes] = GLib.file_get_contents(file.get_path());
                assert(JSON.parse(new TextDecoder().decode(bytes)).lastAccessed === 100,
                    'a canceled write must preserve the existing cache entry');
            }
            assert(lifecycleCache._pendingWrites.size === 0,
                'settled cache writes must release their tracking entries');
        } finally {
            releaseWrite();
            await Promise.allSettled([...lifecycleCache._pendingWrites]);
            Gio.File.prototype.replace_contents_async = originalReplace;
            Gio.File.prototype.enumerate_children_async = originalEnumerate;
            lifecycleService.destroy();
        }
    }

    const lyricsSentinelDirectory = GLib.build_filenamev([tempRoot, 'lyrics']);
    GLib.mkdir_with_parents(lyricsSentinelDirectory, 0o700);
    const lyricsSentinel = GLib.build_filenamev([
        lyricsSentinelDirectory, 'keep.json',
    ]);
    GLib.file_set_contents(lyricsSentinel, '{}');
    await service.clearCache();
    assert(await countTranslationCache(tempRoot) === 0 &&
        GLib.file_test(lyricsSentinel, GLib.FileTest.EXISTS),
    'translation cache clearing should not remove the independent lyrics cache');
    service.destroy();
    secondService.destroy();
    providerService.destroy();
    alternateEndpointService.destroy();
    dedupService.destroy();
    cancelService.destroy();
    missingModelService.destroy();
    partialService.destroy();
    invalidService.destroy();
    longService.destroy();
    await removeTree(Gio.File.new_for_path(tempRoot));
}

const loop = new GLib.MainLoop(null, false);
let scenarioError = null;
run().catch(error => (scenarioError = error)).finally(() => loop.quit());
loop.run();
if (scenarioError)
    throw scenarioError;

print('Translation service cache, race, dedup, skip and batching tests passed');
