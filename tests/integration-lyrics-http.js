import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {LyricsProvider, normalizeLrcApiEndpoint, retryAfterDelayMs} from '../lyrics.js';
import {removeTree} from '../storage.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function sleep(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function response(message, status, body = '') {
    message.set_status(status, null);
    if (body) {
        message.set_response(
            'application/json',
            Soup.MemoryUse.COPY,
            new TextEncoder().encode(body));
    }
}

const server = new Soup.Server();
const receivedRequests = [];
let rateLimitAttempts = 0;
let fallbackRateAttempts = 0;
let plainUpgradeReady = false;
let instrumentalReady = false;
let whitespaceUpgradeReady = false;
const transientAttempts = new Map();
let busyRecovered = false;
server.add_handler(null, (currentServer, message) => {
    const query = decodeURIComponent(message.get_uri().get_query() ?? '');
    const path = message.get_uri().get_path();
    receivedRequests.push({
        path,
        query,
        userAgent: message.get_request_headers().get_one('User-Agent'),
        timeUs: GLib.get_monotonic_time(),
    });

    const scenario = ['Recovery Sequence', 'Busy Forever', 'Cooldown Seed',
        'Backoff Missing', 'Destroy Cooldown', 'Plain Priority Fallback Busy',
        'Plain Priority Fallback Exhausted'].find(name => query.includes(name));
    if (scenario && (!scenario.startsWith('Plain Priority') || path.startsWith('/lrcapi'))) {
        const attempt = transientAttempts.get(scenario) ?? 0;
        transientAttempts.set(scenario, attempt + 1);
        const busy = scenario === 'Busy Forever' ? !busyRecovered :
            scenario === 'Plain Priority Fallback Exhausted' || scenario === 'Destroy Cooldown' ||
            attempt < (scenario === 'Recovery Sequence' || scenario === 'Backoff Missing' ? 2 : 1);
        if (busy) {
            if (scenario !== 'Backoff Missing') {
                message.get_response_headers().append('Retry-After',
                    scenario === 'Recovery Sequence' && attempt === 1
                        ? new Date(Date.now() + 2000).toUTCString() : '1');
            }
            response(message, attempt % 2 === 0 ? 429 : 503);
        } else if (path.startsWith('/lrcapi')) {
            response(message, 200, JSON.stringify([{
                title: scenario, artist: 'LyricGlance', lyrics: '[00:01]recovered fallback',
            }]));
        } else {
            response(message, 200, '{"syncedLyrics":"[00:01]recovered"}');
        }
        return;
    }

    if (path.startsWith('/lrcapi')) {
        const requestedTitle = decodeURIComponent(
            (message.get_uri().get_query() ?? '').match(/(?:^|&)title=([^&]*)/)?.[1] ?? '');
        if (query.includes('Fallback Whitespace Retry') && !whitespaceUpgradeReady) {
            response(message, 200, '[]');
        } else if (query.includes('Fallback Error') || (query.includes('Fallback Raw') &&
            !query.includes('Fallback Raw Success'))) {
            response(message, 500);
        } else if (query.includes('Fallback Empty')) {
            response(message, 200, '[]');
        } else if (query.includes('Fallback Missing')) {
            response(message, 404);
        } else if (query.includes('Fallback Bad JSON')) {
            response(message, 200, '{broken');
        } else if (query.includes('Fallback Bad Shape')) {
            response(message, 200, '{}');
        } else if (query.includes('Fallback Redirect')) {
            message.get_response_headers().append('Location', `${baseUri}/redirect-leak`);
            response(message, 302);
        } else if (query.includes('Fallback Rate') && fallbackRateAttempts++ === 0) {
            message.get_response_headers().append('Retry-After', '1');
            response(message, 429);
        } else {
            const body = JSON.stringify([
                {title: 'Wrong Song', artist: 'Wrong Artist', lyrics: '[00:01]wrong'},
                ...(query.includes('Fallback Modern') ? [{title: requestedTitle,
                    artist: 'LyricGlance', duration: 500, lrc: '[00:01]wrong duration'},
                    {title: requestedTitle, artist: 'LyricGlance', duration: 120,
                        lrc: '[00:01]modern fallback'}] : []),
                ...(query.includes('Fallback Quality') ? [{title: requestedTitle,
                    artist: 'LyricGlance', album: 'HTTP Integration', duration: 120,
                    lyrics: 'high score plain text'}] : []),
                ...(query.includes('Fallback Dual') ? [{title: requestedTitle,
                    artist: 'LyricGlance',
                    lyrics: query.includes('Reverse') ? '[00:01]dual synchronized' : 'dual plain',
                    lrc: query.includes('Reverse') ? 'dual plain' : '[00:01]dual synchronized'}] : []),
                {id: 'remote-id', title: requestedTitle,
                    artist: query.includes('Fallback Reject') ? 'Wrong Artist' : 'LyricGlance',
                    lyrics: query.includes('Fallback Blank Plain') ? '   ' :
                        query.includes('Fallback Plain') || (query.includes('Plain Priority Plain') &&
                        !(plainUpgradeReady && query.includes('Retry'))) ? 'plain from fallback' :
                        `[00:01]${path === '/lrcapi-other' ? 'other endpoint' :
                            query.includes('Fallback Large') ? 'x'.repeat(512) : 'fallback line'}`},
            ]);
            if (query.includes('Fallback Slow')) {
                currentServer.pause_message(message);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    response(message, 200, body);
                    currentServer.unpause_message(message);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                response(message, 200, body);
            }
        }
    } else if (query.includes('Fallback Whitespace Retry') && path.endsWith('/api/get')) {
        response(message, 200, JSON.stringify({plainLyrics: ' \n\t '}));
    } else if (query.includes('Plain Priority') && path.endsWith('/api/get')) {
        response(message, 200, instrumentalReady && query.includes('To Instrumental')
            ? '{"instrumental":true}' : '{"plainLyrics":"plain from primary"}');
    } else if (query.includes('Fallback Raw') && path.endsWith('/api/get')) {
        response(message, 200, JSON.stringify({lyricsfile: 'version: unsupported'}));
    } else if (query.includes('Fallback Unusable') && path.endsWith('/api/get')) {
        response(message, 200, '{"syncedLyrics":null}');
    } else if (query.includes('Fallback') && path.endsWith('/api/get')) {
        response(message, 404);
    } else if (query.includes('Fallback') && path.endsWith('/api/search')) {
        response(message, 200, '[]');
    } else if (query.includes('Instrumental Priority')) {
        response(message, 200, '{"instrumental":true}');
    } else if (query.includes('Search Quality') && path.endsWith('/api/get')) {
        response(message, 404);
    } else if (query.includes('Search Quality') && path.endsWith('/api/search')) {
        response(message, 200, JSON.stringify([
            {id: 201, trackName: 'Search Quality', artistName: 'LyricGlance',
                albumName: 'HTTP Integration', duration: 120, plainLyrics: 'high score plain'},
            {id: 202, trackName: 'Search Quality', artistName: 'LyricGlance',
                syncedLyrics: '[00:01]lower score synchronized'},
        ]));
    } else if (query.includes('Search Match') && path.endsWith('/api/get')) {
        response(message, Soup.Status.NOT_FOUND);
    } else if (query.includes('Search Match') && path.endsWith('/api/search')) {
        response(message, Soup.Status.OK, JSON.stringify([
            {
                id: 90,
                trackName: 'Unrelated first result',
                artistName: 'Someone Else',
                albumName: 'Wrong',
                duration: 120,
                syncedLyrics: '[00:01.00]wrong',
            },
            {
                id: 91,
                trackName: 'Search Match',
                artistName: 'LyricGlance',
                albumName: 'HTTP Integration',
                duration: 120.5,
                syncedLyrics: '[00:01.00]scored candidate',
            },
        ]));
    } else if (query.includes('Search Reject') && path.endsWith('/api/get')) {
        response(message, Soup.Status.NOT_FOUND);
    } else if (query.includes('Search Reject') && path.endsWith('/api/search')) {
        response(message, Soup.Status.OK, JSON.stringify([{
            id: 92,
            trackName: 'Different Song',
            artistName: 'Someone Else',
            albumName: 'Wrong',
            duration: 500,
            syncedLyrics: '[00:01.00]wrong',
        }]));
    } else if (query.includes('Rate Limited') && rateLimitAttempts++ === 0) {
        message.get_response_headers().append('Retry-After', '1');
        response(message, 429);
    } else if (query.includes('Invalid JSON')) {
        response(message, Soup.Status.OK, '{not json');
    } else if (query.includes('HTTP Error')) {
        response(message, Soup.Status.INTERNAL_SERVER_ERROR);
    } else if (query.includes('No Lyrics')) {
        response(message, Soup.Status.OK, '{"syncedLyrics":null}');
    } else if (query.includes('Malformed LRC')) {
        response(message, Soup.Status.OK,
            '{"syncedLyrics":"this has no timestamps"}');
    } else if (query.includes('Large Response')) {
        response(message, Soup.Status.OK, JSON.stringify({
            syncedLyrics: `[00:01.00]${'x'.repeat(256)}`,
        }));
    } else if (query.includes('Slow Request')) {
        currentServer.pause_message(message);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            response(message, Soup.Status.OK,
                '{"syncedLyrics":"[00:01.00] stale"}');
            currentServer.unpause_message(message);
            return GLib.SOURCE_REMOVE;
        });
    } else {
        response(message, Soup.Status.OK,
            '{"syncedLyrics":"[00:01.00] current"}');
    }
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);

const baseUri = server.get_uris()[0].to_string().replace(/\/$/, '');
let provider = new LyricsProvider({
    apiUrl: `${baseUri}/api/get`,
    requestSpacingMs: 0,
    timeoutSeconds: 2,
    persistentCache: false,
});
const baseTrack = {
    artist: 'LyricGlance',
    album: 'HTTP Integration',
    durationUs: 120_000_000,
};

function fetch(title) {
    return new Promise(resolve => {
        provider.fetch({...baseTrack, title}, resolve);
    });
}

const loop = new GLib.MainLoop(null, false);
let scenarioError = null;

async function run() {
    const now = Date.UTC(2026, 9, 15, 0, 0, 0);
    assert(retryAfterDelayMs('2', now) === 2000 &&
        retryAfterDelayMs(new Date(now + 4000).toUTCString(), now) === 4000 &&
        retryAfterDelayMs(new Date(now - 4000).toUTCString(), now) === 1000 &&
        retryAfterDelayMs('0', now) === 1000 &&
        [null, '', '-1', 'invalid'].every(value => retryAfterDelayMs(value, now, 2000) === 2000),
    'Retry-After must support seconds/dates, protect against immediate loops and use backoff for invalid headers');
    const initialStartUs = GLib.get_monotonic_time();
    const valid = await fetch('Valid Lyrics');
    assert(valid?.syncLevel === 'line' && valid.lines[0].text === 'current',
        'a valid syncedLyrics response should normalize to a document');
    const validRequest = receivedRequests.at(-1);
    assert(validRequest.timeUs - initialStartUs >= 550_000,
        'a network lookup should wait for the track to stabilize');
    const validQuery = validRequest.query;
    assert(validQuery.includes('track_name=Valid Lyrics') &&
        validQuery.includes('artist_name=LyricGlance') &&
        validQuery.includes('album_name=HTTP Integration') &&
        validQuery.includes('duration=120'),
        'the LRCLIB request must include title, artist, album and duration');
    assert(validRequest.userAgent === 'LyricGlance/0.9.0 (lyric-glance@eureka)',
        'requests should identify this extension, not impersonate a browser');
    const afterFirstValid = receivedRequests.length;
    const cachedValid = await fetch('Valid Lyrics');
    assert(cachedValid?.lines?.[0]?.text === 'current' &&
        receivedRequests.length === afterFirstValid,
        'a successful result should be served from the session cache');

    const beforeSkipped = receivedRequests.length;
    let skippedCallbacks = 0;
    provider.fetch({...baseTrack, title: 'Skipped A'}, () => skippedCallbacks++);
    await sleep(150);
    provider.fetch({...baseTrack, title: 'Skipped B'}, () => skippedCallbacks++);
    await sleep(150);
    assert((await fetch('Stable C'))?.lines?.length &&
        receivedRequests.length === beforeSkipped + 1 && skippedCallbacks === 0 &&
        receivedRequests.at(-1).query.includes('Stable C'),
    'rapid track changes must debounce to one request for the latest song');
    assert(await fetch('Invalid JSON') === null,
        'invalid JSON should safely return no lyrics');
    assert(await fetch('HTTP Error') === null,
        'an HTTP error should safely return no lyrics');
    assert(await fetch('No Lyrics') === null,
        'a response without syncedLyrics should safely return no lyrics');
    const afterFirstNoLyrics = receivedRequests.length;
    assert(await fetch('No Lyrics') === null &&
        receivedRequests.length === afterFirstNoLyrics,
        'a no-lyrics result should be served from the session cache');
    assert(await fetch('Malformed LRC') === null,
        'malformed LRC should safely return no lyrics');

    const limitedProvider = new LyricsProvider({
        apiUrl: `${baseUri}/api/get`,
        requestSpacingMs: 0,
        maxResponseBytes: 64,
        persistentCache: false,
    });
    const oversized = await new Promise(resolve => {
        limitedProvider.fetch(
            {...baseTrack, title: 'Large Response'}, resolve);
    });
    assert(oversized === null,
        'an LRCLIB response above the configured limit should be rejected');
    limitedProvider.destroy();

    await fetch('Cache A');
    await fetch('Cache B');
    const afterCacheB = receivedRequests.length;
    const cacheAAgain = await fetch('Cache A');
    assert(cacheAAgain?.lines?.[0]?.text === 'current' &&
        receivedRequests.length === afterCacheB,
        'A -> B -> A should reuse A without another HTTP request');

    const evictionProvider = new LyricsProvider({
        apiUrl: `${baseUri}/api/get`,
        requestSpacingMs: 0,
        timeoutSeconds: 2,
        maxCacheEntries: 2,
        persistentCache: false,
    });
    const evictionFetch = title => new Promise(resolve => {
        evictionProvider.fetch({...baseTrack, title}, resolve);
    });
    const beforeEviction = receivedRequests.length;
    await evictionFetch('Eviction A');
    await evictionFetch('Eviction B');
    await evictionFetch('Eviction A');
    await evictionFetch('Eviction C');
    await evictionFetch('Eviction B');
    assert(receivedRequests.length === beforeEviction + 4,
        'the bounded LRU cache should refresh hits and evict the oldest entry');
    evictionProvider.destroy();

    const beforeSearch = receivedRequests.length;
    const searched = await fetch('Search Match');
    assert(searched?.sourceId === 91 &&
        searched.lines[0].text === 'scored candidate' &&
        receivedRequests.length === beforeSearch + 2 &&
        receivedRequests.at(-1).path.endsWith('/api/search') &&
        !receivedRequests.at(-1).query.includes('duration='),
    'a /get 404 should search and score all candidates instead of taking the first');
    assert(await fetch('Search Reject') === null,
        'a low-confidence search result should be treated as no lyrics');

    const rateLimitStartUs = GLib.get_monotonic_time();
    const rateLimited = await fetch('Rate Limited');
    const rateLimitDelayMs =
        (GLib.get_monotonic_time() - rateLimitStartUs) / 1000;
    assert(rateLimited?.lines?.[0]?.text === 'current' &&
        rateLimitAttempts === 2 && rateLimitDelayMs >= 900,
    '429 handling should honor Retry-After before retrying');

    const recoveryStates = [];
    let retryStarted;
    const retrySignal = new Promise(resolve => (retryStarted = resolve));
    const recoveryTrack = {...baseTrack, title: 'Recovery Sequence'};
    const recovering = new Promise(resolve => provider.fetch(
        recoveryTrack,
        (document, status) => resolve({document, status}),
        state => {
            recoveryStates.push(state);
            retryStarted();
        }));
    await retrySignal;
    const joinedRecovery = new Promise(resolve => provider.fetch(
        recoveryTrack, resolve, state => recoveryStates.push(state)));
    const [recovery, joined] = await Promise.all([recovering, joinedRecovery]);
    const recoveryRequests = receivedRequests.filter(item => item.query.includes('Recovery Sequence'));
    assert(recovery.document?.lines?.[0]?.text === 'recovered' && recovery.status === 'complete' &&
        recoveryRequests.length === 3 && joined === recovery.document &&
        recoveryStates.length === 2 && recoveryStates.every(state => state.status === 'retrying') &&
        recoveryRequests.slice(1).every((item, i) => item.timeUs - recoveryRequests[i].timeUs >= 900_000),
    '429 then 503 must recover, respecting both numeric and HTTP-date Retry-After headers');

    const backoff = await fetch('Backoff Missing');
    const backoffRequests = receivedRequests.filter(item => item.query.includes('Backoff Missing'));
    assert(backoff?.lines?.[0]?.text === 'recovered' && backoffRequests.length === 3 &&
        backoffRequests[1].timeUs - backoffRequests[0].timeUs >= 900_000 &&
        backoffRequests[2].timeUs - backoffRequests[1].timeUs >= 1_900_000,
    'missing Retry-After must use increasing backoff rather than immediate repeated requests');

    let staleRetryCallbacks = 0;
    await new Promise(resolve => provider.fetch(
        {...baseTrack, title: 'Cooldown Seed'}, () => staleRetryCallbacks++, resolve));
    const seedRequest = receivedRequests.at(-1);
    const beforeCooldownCache = receivedRequests.length;
    const cachedStartUs = GLib.get_monotonic_time();
    assert((await fetch('Valid Lyrics'))?.lines?.length &&
        receivedRequests.length === beforeCooldownCache &&
        GLib.get_monotonic_time() - cachedStartUs < 300_000,
    'cached lyrics must remain immediately available during a service cooldown');
    await provider.clearCaches();
    provider.fetch({...baseTrack, title: 'Cooldown Skipped'}, () => staleRetryCallbacks++);
    await sleep(100);
    assert((await fetch('Cooldown Fresh'))?.lines?.length && staleRetryCallbacks === 0 &&
        receivedRequests.at(-1).timeUs - seedRequest.timeUs >= 900_000 &&
        !receivedRequests.some(item => item.query.includes('Cooldown Skipped')) &&
        transientAttempts.get('Cooldown Seed') === 1,
    'song changes and cache clearing must retain the service cooldown and discard older retries');

    const exhausted = await new Promise(resolve => provider.fetch(
        {...baseTrack, title: 'Busy Forever'},
        (document, status) => resolve({document, status})));
    assert(exhausted.document === null && exhausted.status === 'unavailable' &&
        transientAttempts.get('Busy Forever') === 5,
    'persistent 429/503 must stop after four retries and report unavailable, not missing');
    const afterExhaustion = receivedRequests.length;
    await sleep(1200);
    assert(receivedRequests.length === afterExhaustion,
        'exhausted retries must not leave a background polling loop');
    busyRecovered = true;
    assert((await fetch('Busy Forever'))?.lines?.[0]?.text === 'recovered',
        'temporary failures must not create a negative session cache entry');

    const pendingCooldownProvider = new LyricsProvider({
        apiUrl: `${baseUri}/api/get`, persistentCache: false,
    });
    let destroyedRetryCallbacks = 0;
    await new Promise(resolve => pendingCooldownProvider.fetch(
        {...baseTrack, title: 'Destroy Cooldown'}, () => destroyedRetryCallbacks++, resolve));
    pendingCooldownProvider.destroy();
    const afterCooldownDestroy = receivedRequests.length;
    await sleep(1200);
    assert(receivedRequests.length === afterCooldownDestroy && destroyedRetryCallbacks === 0,
        'destroy must cancel the pending cooldown without requests or completion callbacks');

    const beforeCoalesced = receivedRequests.length;
    const coalescedTrack = {...baseTrack, title: 'Coalesced Slow Request'};
    const coalesced = await Promise.all([
        new Promise(resolve => provider.fetch(coalescedTrack, resolve)),
        new Promise(resolve => provider.fetch(coalescedTrack, resolve)),
    ]);
    assert(receivedRequests.length === beforeCoalesced + 1 &&
        coalesced.every(document => document?.lines?.[0]?.text === 'stale'),
    'concurrent requests for the same track should be coalesced');

    let staleCallbacks = 0;
    provider.fetch(
        {...baseTrack, title: 'Slow Request'},
        () => staleCallbacks++);
    await sleep(700);
    const current = await fetch('Current Request');
    assert(current?.lines?.[0]?.text === 'current',
        'the replacement request should return current lyrics');
    await sleep(650);
    assert(staleCallbacks === 0,
        'a delayed stale response must not invoke its callback');

    for (const url of ['https://example.test/jsonapi', 'http://127.0.0.1:28883/jsonapi',
        'http://[::1]:28883/api/v1/lyrics/advance'])
        assert(normalizeLrcApiEndpoint(url) === url, 'valid endpoint was rejected');
    for (const url of ['http://example.test/jsonapi', 'https://user:key@example.test/jsonapi',
        'https://example.test/jsonapi?key=secret', 'https://example.test/jsonapi#fragment',
        'file:///tmp/lyrics', 'not a URL'])
        assert(normalizeLrcApiEndpoint(url) === null, 'unsafe endpoint was accepted');

    const fallbackRoot = GLib.dir_make_tmp('lyricglance-lrcapi-XXXXXX');
    const options = {apiUrl: `${baseUri}/api/get`, requestSpacingMs: 0,
        lrcApiEnabled: true, lrcApiUrl: `${baseUri}/lrcapi`, cacheRoot: fallbackRoot};
    let fallback = new LyricsProvider(options);
    const fallbackFetch = title => new Promise(resolve =>
        fallback.fetch({...baseTrack, title}, resolve));
    const plainStates = [];
    const upgraded = await new Promise(resolve => fallback.fetch(
        {...baseTrack, title: 'Plain Priority Fallback Busy'}, resolve,
        state => plainStates.push(state)));
    assert(plainStates.length === 1 && plainStates[0].document?.source === 'lrclib-plain' &&
        plainStates[0].document.lines[0].text === 'plain from primary' &&
        upgraded?.source === 'lrcapi-synced',
    'fallback retries must expose existing primary plain lyrics and later upgrade to timed lyrics');
    const retained = await new Promise(resolve => fallback.fetch(
        {...baseTrack, title: 'Plain Priority Fallback Exhausted'},
        (document, status) => resolve({document, status})));
    assert(retained.document?.source === 'lrclib-plain' && retained.status === 'complete',
        'exhausting fallback retries must retain primary plain lyrics');
    const failedDisk = await new Promise(resolve => fallback.fetch(
        {...baseTrack, title: 'Destroy Cooldown'},
        (document, status) => resolve({document, status})));
    assert(failedDisk.document === null && failedDisk.status === 'unavailable',
        'a failed persistent-cache lookup must remain distinguishable from a missing song');
    await Promise.all([...fallback._diskCache._pendingWrites]);
    assert(!(await fallback._diskCache.get({...baseTrack, title: 'Destroy Cooldown'})).hit,
        'temporary failure must not write a negative disk cache');
    assert(await fallbackFetch('Fallback Whitespace Retry') === null,
        'whitespace-only primary lyrics must not masquerade as usable plain text');
    await Promise.all([...fallback._diskCache._pendingWrites]);
    assert(!(await fallback._diskCache.get({...baseTrack, title: 'Fallback Whitespace Retry'})).hit,
        'a blank primary and empty fallback must not persist a negative cache');
    // Simulate an entry written by the old whitespace handling. It must not
    // block an enabled fallback after upgrading the extension.
    await fallback._diskCache.put({...baseTrack, title: 'Fallback Whitespace Retry'},
        {plainLyrics: ' \n\t '});
    fallback.destroy();
    fallback = new LyricsProvider(options);
    whitespaceUpgradeReady = true;
    const beforeWhitespaceRetry = receivedRequests.length;
    assert((await fallbackFetch('Fallback Whitespace Retry'))?.source === 'lrcapi-synced' &&
        receivedRequests.length > beforeWhitespaceRetry,
    'recreating the provider must retry and upgrade even with a legacy negative cache');
    assert((await fallbackFetch('Search Quality'))?.sourceId === 202,
        'credible synchronized search candidates must outrank higher-scoring plain candidates');
    assert((await fallbackFetch('Fallback Quality'))?.lines[0].text === 'fallback line',
        'credible synchronized fallback candidates must outrank higher-scoring plain candidates');
    for (const title of ['Fallback Dual', 'Fallback Dual Reverse'])
        assert((await fallbackFetch(title))?.lines[0].text === 'dual synchronized',
            'both reply fields must be considered before preferring plain text');
    const beforePrimary = receivedRequests.length;
    assert((await fallbackFetch('Primary Priority'))?.source === 'lrclib-synced' &&
        (await fallbackFetch('Instrumental Priority'))?.instrumental &&
        receivedRequests.slice(beforePrimary).every(item => item.path === '/api/get'),
    'synchronized primary lyrics and instrumental records must never contact the fallback');
    assert((await fallbackFetch('Plain Priority Upgrade'))?.source === 'lrcapi-synced',
        'fallback synchronized lyrics must upgrade primary plain lyrics');
    assert((await fallbackFetch('Plain Priority Plain'))?.source === 'lrclib-plain',
        'equally plain fallback lyrics must not replace primary lyrics');
    for (const suffix of ['Fallback Error', 'Fallback Empty', 'Fallback Missing',
        'Fallback Bad JSON', 'Fallback Bad Shape', 'Fallback Reject', 'Fallback Redirect',
        'Fallback Blank Plain']) {
        const title = `Plain Priority ${suffix}`;
        const document = await fallbackFetch(title);
        assert(document?.source === 'lrclib-plain' && document.lines[0].text === 'plain from primary',
            `${suffix} must preserve usable primary text`);
    }
    const plainOnly = await fallbackFetch('Fallback Plain Only');
    assert(plainOnly?.source === 'lrcapi-plain' && plainOnly.syncLevel === 'none',
        'plain fallback text is better than no lyrics');
    assert((await fallbackFetch('Plain Priority Plain Retry'))?.source === 'lrclib-plain',
        'plain baseline lookup failed');
    await Promise.all([...fallback._diskCache._pendingWrites]);
    fallback.destroy();
    fallback = new LyricsProvider(options);
    plainUpgradeReady = true;
    assert((await fallbackFetch('Plain Priority Plain Retry'))?.source === 'lrcapi-synced',
        'cached plain lyrics must not prevent a later synchronized upgrade');
    assert((await fallbackFetch('Plain Priority Plain To Instrumental'))?.source === 'lrclib-plain',
        'instrumental upgrade baseline failed');
    await Promise.all([...fallback._diskCache._pendingWrites]);
    fallback.destroy();
    fallback = new LyricsProvider(options);
    instrumentalReady = true;
    const beforeInstrumentalUpgrade = receivedRequests.length;
    assert((await fallbackFetch('Plain Priority Plain To Instrumental'))?.instrumental &&
        receivedRequests.length === beforeInstrumentalUpgrade + 1,
    'a primary instrumental result must override cached plain lyrics without a fallback request');
    const beforeFallback = receivedRequests.length;
    const fallbackDocument = await fallbackFetch('Fallback Match');
    assert(fallbackDocument?.source === 'lrcapi-synced' &&
        fallbackDocument.sourceId === null && fallbackDocument.lines[0].text === 'fallback line' &&
        receivedRequests.length === beforeFallback + 3 &&
        receivedRequests.at(-1).query.includes('title=Fallback Match') &&
        receivedRequests.at(-1).query.includes('artist=LyricGlance') &&
        receivedRequests.at(-1).query.includes('album=HTTP Integration') &&
        !receivedRequests.at(-1).query.includes('track_name='),
    'the fallback must use its query contract, score candidates and preserve source identity');
    assert((await fallbackFetch('Fallback Modern'))?.lines[0].text === 'modern fallback',
        'the modern lrc field must work and reject a candidate with mismatched duration');
    assert((await fallbackFetch('Fallback Unusable'))?.source === 'lrcapi-synced',
        'an unusable successful primary response must try the fallback');
    await Promise.all([...fallback._diskCache._pendingWrites]);
    fallback.destroy();
    fallback = new LyricsProvider(options);
    const beforeDiskHit = receivedRequests.length;
    assert((await fallbackFetch('Fallback Match'))?.source === 'lrcapi-synced' &&
        receivedRequests.length === beforeDiskHit,
    'recreation must reuse fallback disk data with the correct source');
    fallback.destroy();
    fallback = new LyricsProvider({...options, lrcApiUrl: `${baseUri}/lrcapi-other`});
    assert((await fallbackFetch('Fallback Match'))?.lines[0].text === 'other endpoint',
        "changing endpoint must not reuse another endpoint's cached lyrics");
    await Promise.all([...fallback._diskCache._pendingWrites]);
    fallback.destroy();
    fallback = new LyricsProvider({...options, lrcApiEnabled: false});
    const beforeDisabled = receivedRequests.length;
    assert(await fallbackFetch('Fallback Match') === null &&
        receivedRequests.length === beforeDisabled + 2,
    'disabled fallback must neither reuse its cache nor contact its endpoint');
    await Promise.all([...fallback._diskCache._pendingWrites]);
    fallback.destroy();
    fallback = new LyricsProvider(options);
    assert((await fallbackFetch('Fallback Match'))?.source === 'lrcapi-synced',
        'a disabled primary negative cache must not block an enabled fallback');
    for (const title of ['Fallback Error', 'Fallback Empty', 'Fallback Missing',
        'Fallback Bad JSON', 'Fallback Bad Shape', 'Fallback Reject', 'Fallback Redirect',
        'Fallback Blank Plain']) {
        const before = receivedRequests.length;
        assert(await fallbackFetch(title) === null, `${title} must not fabricate lyrics`);
        assert(!(await fallback._diskCache.get({...baseTrack, title})).hit,
            `${title} must not persist a negative cache entry`);
        assert(await fallbackFetch(title) === null && receivedRequests.length === before + 6,
            `${title} must remain retryable instead of returning a cached miss`);
    }
    assert((await fallbackFetch('Fallback Raw Success'))?.source === 'lrcapi-synced',
        'a successful fallback must replace unrenderable primary data');
    await Promise.all([...fallback._diskCache._pendingWrites]);
    const replacement = await fallback._diskCache.get({...baseTrack, title: 'Fallback Raw Success'});
    assert(replacement.payload.provider === 'lrcapi' && replacement.payload.lyricsfile === null,
        'unrenderable primary data must not race with and overwrite fallback cache data');
    assert(await fallbackFetch('Fallback Raw') === null,
        'unrenderable primary lyrics and failed fallback must not fabricate success');
    await Promise.all([...fallback._diskCache._pendingWrites]);
    const raw = await fallback._diskCache.get({...baseTrack, title: 'Fallback Raw'});
    assert(raw.hit && !raw.record.negative && raw.payload.lyricsfile === 'version: unsupported',
        'a failed fallback must preserve unrenderable nonempty primary data for future parsers');
    fallback.destroy();
    fallback = new LyricsProvider(options);
    const beforeRawRetry = receivedRequests.length;
    assert(await fallbackFetch('Fallback Raw') === null &&
        receivedRequests.length === beforeRawRetry + 2,
    'unrenderable raw disk data must remain retryable after recreation');
    assert(!receivedRequests.some(item => item.path === '/redirect-leak'),
        'redirects must not disclose song metadata to another endpoint');
    const beforePrimaryError = receivedRequests.length;
    assert(await fallbackFetch('HTTP Error') === null &&
        receivedRequests.length === beforePrimaryError + 1,
    'a primary transport/service failure must not masquerade as a missing lyric');
    const rateStart = GLib.get_monotonic_time();
    assert((await fallbackFetch('Fallback Rate'))?.source === 'lrcapi-synced' &&
        fallbackRateAttempts === 2 && GLib.get_monotonic_time() - rateStart >= 900_000,
    'fallback rate limiting must honor Retry-After before retrying');
    const beforeCoalescedFallback = receivedRequests.length;
    const sharedTrack = {...baseTrack, title: 'Fallback Slow Shared'};
    const shared = await Promise.all([
        new Promise(resolve => fallback.fetch(sharedTrack, resolve)),
        new Promise(resolve => fallback.fetch(sharedTrack, resolve)),
    ]);
    assert(shared.every(item => item?.source === 'lrcapi-synced') &&
        receivedRequests.length === beforeCoalescedFallback + 3,
    'coalesced fallback lookups must share one HTTP chain');
    let staleFallbackCallbacks = 0;
    fallback.fetch({...baseTrack, title: 'Plain Priority Fallback Slow Cancel'}, () => staleFallbackCallbacks++);
    await sleep(700);
    assert((await fallbackFetch('Fallback Current'))?.source === 'lrcapi-synced',
        'replacement fallback lookup failed');
    await sleep(550);
    assert(staleFallbackCallbacks === 0, 'switching tracks must suppress old fallback callbacks');
    fallback.fetch({...baseTrack, title: 'Plain Priority Fallback Slow Destroy'}, () => staleFallbackCallbacks++);
    await sleep(700);
    fallback.destroy();
    await sleep(550);
    assert(staleFallbackCallbacks === 0, 'destroy must suppress in-flight fallback callbacks');
    const smallFallback = new LyricsProvider({...options, persistentCache: false, maxResponseBytes: 64});
    assert(await new Promise(resolve => smallFallback.fetch(
        {...baseTrack, title: 'Fallback Large'}, resolve)) === null,
    'oversized fallback responses must be rejected');
    smallFallback.destroy();
    await removeTree(Gio.File.new_for_path(fallbackRoot));

    let destroyedCallbacks = 0;
    provider.fetch(
        {...baseTrack, title: 'Slow Request'},
        () => destroyedCallbacks++);
    await sleep(700);
    provider.destroy();
    provider = null;
    await sleep(650);
    assert(destroyedCallbacks === 0,
        'destroy() must suppress an in-flight Soup response');
}

run()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

provider?.destroy();
server.disconnect();

if (scenarioError)
    throw scenarioError;

print('LRCLIB and LrcAPI matching, debounce, 429/503 recovery, cache and cancellation tests passed');
