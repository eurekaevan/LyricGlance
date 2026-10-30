import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {createLyricsDocument} from '../lyrics-document.js';
import {removeTree, trackKey} from '../storage.js';
import {TranslationDiskCache} from '../translation-cache.js';
import {alignTranslation} from '../translation-document.js';
import {
    MockTranslationProvider,
    TranslationProviderError,
} from '../translation-provider.js';
import {
    TranslationService,
    TranslationStatus,
} from '../translation-service.js';

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
        alignTranslation(lyrics, result.document)[0] === '[zh-CN] Line 1',
    'the mock provider should translate a complete song once');

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

    const delayed = new MockTranslationProvider({delayMs: 100});
    const dedupService = new TranslationService({
        providers: [delayed],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'dedup']),
        }),
    });
    const first = dedupService.translate(lyrics, options());
    const duplicate = dedupService.translate(lyrics, options());
    assert(first === duplicate,
        'identical translation calls should await the same promise');
    await Promise.all([first, duplicate]);
    assert(delayed.requestCount === 1,
        'request deduplication should consume one provider request');

    const cancelProvider = new MockTranslationProvider({delayMs: 500});
    const cancelService = new TranslationService({
        providers: [cancelProvider],
        credentialStore: noCredential,
        cache: new TranslationDiskCache({
            cacheRoot: GLib.build_filenamev([tempRoot, 'cancel']),
        }),
    });
    const canceledPromise = cancelService.translate(lyrics, options());
    cancelService.cancelAll();
    result = await canceledPromise;
    assert(result.status === TranslationStatus.CANCELED,
        'track changes should cancel stale translation work');

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
    result = await service.translate(lyricsDocument({language: 'zh_CN'}),
        options({providerId: 'not-configured', forceRefresh: true}));
    assert(result.status === TranslationStatus.SAME_LANGUAGE &&
        provider.requestCount === requestsBeforeSkip,
    'same-language lyrics must skip translation even without a configured provider');
    const unmarkedLyrics = createLyricsDocument({
        source: 'test',
        lines: [{text: 'Every morning we open the windows and listen to the quiet sounds outside. We walk together through the city and talk about the things we hope to do tomorrow. The road is long but we have enough time to find our way home.'}],
    });
    result = await service.translate(unmarkedLyrics,
        options({targetLanguage: 'en-US', providerId: 'not-configured', forceRefresh: true}));
    assert(result.status === TranslationStatus.SAME_LANGUAGE && provider.requestCount === requestsBeforeSkip,
        'confidently identified unmarked lyrics must skip translation without provider configuration');
    result = await service.translate(unmarkedLyrics,
        options({targetLanguage: 'zh-CN', forceRefresh: true}));
    assert(result.status === TranslationStatus.AVAILABLE && provider.requestCount === requestsBeforeSkip + 1,
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

    const lyricsSentinelDirectory = GLib.build_filenamev([tempRoot, 'lyrics']);
    GLib.mkdir_with_parents(lyricsSentinelDirectory, 0o700);
    const lyricsSentinel = GLib.build_filenamev([
        lyricsSentinelDirectory, 'keep.json',
    ]);
    GLib.file_set_contents(lyricsSentinel, '{}');
    await service.clearCache();
    assert(await cache.count() === 0 &&
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
