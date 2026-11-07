import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {LyricsProvider} from '../lyrics.js';
import {
    clearLyricsCache,
    countLyricsCache,
    LyricsDiskCache,
    OffsetStore,
    removeTree,
    trackHash,
} from '../storage.js';

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

async function waitForFile(path) {
    for (let attempt = 0; attempt < 40; attempt++) {
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return;
        await sleep(25);
    }
    throw new Error(`timed out waiting for cache file ${path}`);
}

const tempRoot = GLib.dir_make_tmp('lyric-glance-storage-XXXXXX');
const trackA = {
    title: 'Persistent A',
    artist: 'Storage Artist',
    album: 'Cache Album',
    durationUs: 180_000_000,
};
const trackB = {...trackA, title: 'Persistent B'};
const trackC = {...trackA, title: 'Persistent C'};

const server = new Soup.Server();
let networkRequests = 0;
server.add_handler(null, (_server, message) => {
    networkRequests++;
    const query = decodeURIComponent(message.get_uri().get_query() ?? '');
    const noLyrics = query.includes('No Lyrics');
    message.set_status(Soup.Status.OK, null);
    message.set_response(
        'application/json',
        Soup.MemoryUse.COPY,
        new TextEncoder().encode(JSON.stringify({
            id: noLyrics ? 0 : 42,
            syncedLyrics: noLyrics ? null : '[00:01.00] persistent line',
        })));
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
const apiUrl = `${server.get_uris()[0].to_string().replace(/\/$/, '')}/api/get`;

function providerFetch(provider, track) {
    return new Promise(resolve => provider.fetch(track, resolve));
}

const loop = new GLib.MainLoop(null, false);
let scenarioError = null;

async function run() {
    const countRoot = GLib.build_filenamev([tempRoot, 'count-cache']);
    assert(await countLyricsCache(countRoot) === 0,
        'a missing lyrics cache directory should count as empty');
    const countWriter = new LyricsDiskCache({cacheRoot: countRoot});
    await countWriter.put(trackA, {syncedLyrics: '[00:01.00] persisted'});
    await countWriter.put(trackB, null);
    countWriter.destroy();
    const countDirectory = GLib.build_filenamev([countRoot, 'lyrics']);
    GLib.file_set_contents(GLib.build_filenamev([countDirectory, 'notes.txt']), 'ignored');
    Gio.File.new_for_path(GLib.build_filenamev([countDirectory, 'nested.json']))
        .make_directory(null);
    assert(await countLyricsCache(countRoot) === 2,
        'lyrics count should include positive and negative JSON files, excluding other files and directories');
    const reopened = new LyricsDiskCache({cacheRoot: countRoot});
    assert((await reopened.get(trackA)).hit && await countLyricsCache(countRoot) === 2,
        'a fresh cache instance should find persisted entries and retain their count');
    await reopened.clear();
    assert(await countLyricsCache(countRoot) === 0,
        'clearing persisted lyrics should reset the count');
    reopened.destroy();

    const accessIntervalMs = 12 * 60 * 60 * 1000;
    const accessCacheRoot = GLib.build_filenamev([tempRoot, 'access-cache']);
    const accessConfigRoot = GLib.build_filenamev([tempRoot, 'access-offsets']);
    let accessNow = 100;
    const accessCache = new LyricsDiskCache({
        cacheRoot: accessCacheRoot,
        now: () => accessNow,
    });
    const accessOffsets = new OffsetStore({
        configRoot: accessConfigRoot,
        now: () => accessNow,
    });
    await accessOffsets.ready();
    const accessLyricsPath = GLib.build_filenamev([
        accessCacheRoot, 'lyrics', `${trackHash(trackA)}.json`,
    ]);
    const accessOffsetsPath = GLib.build_filenamev([accessConfigRoot, 'offsets.json']);
    const accessWrites = new Map([[accessLyricsPath, 0], [accessOffsetsPath, 0]]);
    const originalReplace = Gio.File.prototype.replace_contents_async;
    Gio.File.prototype.replace_contents_async = function (...args) {
        const path = this.get_path();
        if (accessWrites.has(path))
            accessWrites.set(path, accessWrites.get(path) + 1);
        return originalReplace.apply(this, args);
    };
    try {
        await accessCache.put(trackA, {syncedLyrics: '[00:01.00] throttled access'});
        accessOffsets.set(trackA, 1000);
        await accessOffsets.flush();
        assert(accessWrites.get(accessLyricsPath) === 1 &&
            accessWrites.get(accessOffsetsPath) === 1,
        'initial lyrics and offset values must each be written once');

        for (const elapsed of [1, accessIntervalMs - 1, accessIntervalMs]) {
            accessNow = 100 + elapsed;
            for (let repeat = 0; repeat < 3; repeat++) {
                assert((await accessCache.get(trackA)).hit && accessOffsets.get(trackA) === 1000,
                    'repeated access within twelve hours must retain the cached lyrics and offset');
            }
            await Promise.all([...accessCache._pendingWrites]);
            await accessOffsets.flush();
            assert(accessWrites.get(accessLyricsPath) === 1 &&
                accessWrites.get(accessOffsetsPath) === 1,
            'access before or exactly at twelve hours must not rewrite lyrics or offsets');
        }

        accessNow = 100 + accessIntervalMs + 1;
        assert((await accessCache.get(trackA)).hit && accessOffsets.get(trackA) === 1000,
            'access beyond twelve hours must still return the stored values');
        await Promise.all([...accessCache._pendingWrites]);
        await accessOffsets.flush();
        assert(accessWrites.get(accessLyricsPath) === 2 &&
            accessWrites.get(accessOffsetsPath) === 2,
        'access beyond twelve hours must refresh lyrics and offsets exactly once');
        for (let repeat = 0; repeat < 3; repeat++) {
            assert((await accessCache.get(trackA)).hit && accessOffsets.get(trackA) === 1000,
                'a refreshed access time must preserve the stored values');
        }
        await Promise.all([...accessCache._pendingWrites]);
        await accessOffsets.flush();
        assert(accessWrites.get(accessLyricsPath) === 2 &&
            accessWrites.get(accessOffsetsPath) === 2,
        'repeated access after a refresh must not immediately rewrite either file');

        accessOffsets.set(trackA, 1500);
        await accessOffsets.flush();
        const [, lyricsBytes] = GLib.file_get_contents(accessLyricsPath);
        const [, offsetBytes] = GLib.file_get_contents(accessOffsetsPath);
        const lyricsRecord = JSON.parse(new TextDecoder().decode(lyricsBytes));
        const offsetRecord = JSON.parse(new TextDecoder().decode(offsetBytes));
        assert(lyricsRecord.version === 2 && lyricsRecord.lastAccessed === accessNow &&
            offsetRecord.version === 1 &&
            offsetRecord.entries[trackHash(trackA)].lastAccessed === accessNow &&
            offsetRecord.entries[trackHash(trackA)].offsetMs === 1500 &&
            accessWrites.get(accessOffsetsPath) === 3,
        'changing an offset must persist immediately within the refresh interval without changing file formats');
    } finally {
        await Promise.allSettled([...accessCache._pendingWrites]);
        await accessOffsets.flush();
        Gio.File.prototype.replace_contents_async = originalReplace;
        accessCache.destroy();
        accessOffsets.destroy();
    }

    const destroyedRoot = GLib.build_filenamev([tempRoot, 'destroyed-read']);
    let destroyedNow = 100;
    const destroyedCache = new LyricsDiskCache({cacheRoot: destroyedRoot, now: () => destroyedNow});
    await destroyedCache.put(trackA, {syncedLyrics: '[00:01.00] keep persisted access'});
    destroyedNow += accessIntervalMs + 1;
    const pendingDestroyedRead = destroyedCache.get(trackA);
    destroyedCache.destroy();
    assert(!(await pendingDestroyedRead).hit,
        'destroying a cache during its disk read must prevent a late cache hit');
    await Promise.allSettled([...destroyedCache._pendingWrites]);
    const [, destroyedBytes] = GLib.file_get_contents(GLib.build_filenamev([
        destroyedRoot, 'lyrics', `${trackHash(trackA)}.json`,
    ]));
    assert(JSON.parse(new TextDecoder().decode(destroyedBytes)).lastAccessed === 100,
        'a disk read completed after destruction must not rewrite the persisted access time');

    let now = 10_000;
    const directRoot = GLib.build_filenamev([tempRoot, 'direct-cache']);
    const diskCache = new LyricsDiskCache({
        cacheRoot: directRoot,
        positiveTtlMs: 100,
        negativeTtlMs: 50,
        maxEntries: 3,
        now: () => now,
    });
    await diskCache.put(trackA, {
        id: 7,
        syncedLyrics: '[00:01.00] cached A',
    });
    let cached = await diskCache.get(trackA);
    assert(cached.hit && cached.payload.syncedLyrics.includes('cached A') &&
        cached.record.id === 7 && cached.record.version === 2,
    'a positive disk entry should retain raw lyrics and the LRCLIB ID');

    await diskCache.put(trackB, null);
    cached = await diskCache.get(trackB);
    assert(cached.hit && cached.payload === null && cached.record.negative,
        'a no-lyrics result should be a negative disk-cache hit');

    await diskCache.put(trackC, {
        id: 310861,
        instrumental: true,
        plainLyrics: null,
        syncedLyrics: null,
        lyricsfile: "version: '1.0'\nmetadata:\n  title: Sweden\n  artist: C418\n  instrumental: true\n",
    });
    cached = await diskCache.get(trackC);
    assert(cached.hit && cached.payload.instrumental && !cached.record.negative,
        'instrumental lyrics should be a positive cache entry');

    const trackAPath = GLib.build_filenamev([
        directRoot, 'lyrics', `${trackHash(trackA)}.json`,
    ]);
    GLib.file_set_contents(trackAPath, '{broken json');
    cached = await diskCache.get(trackA);
    assert(!cached.hit, 'corrupt JSON should be treated as a safe miss');

    GLib.file_set_contents(trackAPath, JSON.stringify({
        version: 1,
        trackHash: trackHash(trackA),
        title: trackA.title,
        artist: trackA.artist,
        album: trackA.album,
        durationUs: trackA.durationUs,
        resultId: 17,
        syncedLyrics: '[00:01.00] legacy cached line',
        negative: false,
        fetchedAt: now,
        lastAccessed: now,
    }));
    cached = await diskCache.get(trackA);
    assert(cached.hit && cached.payload.id === 17 &&
        cached.payload.syncedLyrics.includes('legacy cached line'),
    'a safe version 1 entry should remain readable as raw provider data');

    await diskCache.put(trackA, {syncedLyrics: '[00:01.00] fresh'});
    now += 101;
    cached = await diskCache.get(trackA);
    assert(!cached.hit, 'an expired positive entry should be a miss');
    now += 50;
    cached = await diskCache.get(trackB);
    assert(!cached.hit, 'an expired negative entry should be a miss');

    const evictionRoot = GLib.build_filenamev([tempRoot, 'eviction-cache']);
    let evictionNow = 1;
    const evictionCache = new LyricsDiskCache({
        cacheRoot: evictionRoot,
        maxEntries: 2,
        now: () => evictionNow++,
    });
    await evictionCache.put(trackA, {syncedLyrics: '[00:01.00] A'});
    await evictionCache.put(trackB, {syncedLyrics: '[00:01.00] B'});
    await evictionCache.put(trackC, {syncedLyrics: '[00:01.00] C'});
    assert(!(await evictionCache.get(trackA)).hit &&
        (await evictionCache.get(trackB)).hit &&
        (await evictionCache.get(trackC)).hit,
    'disk eviction should remove the oldest entry above the size limit');

    const malformedRoot = GLib.build_filenamev([tempRoot, 'malformed-cache']);
    const malformedCache = new LyricsDiskCache({cacheRoot: malformedRoot});
    await malformedCache.put(trackA, {
        id: 99,
        instrumental: false,
        plainLyrics: 'plain fallback',
        syncedLyrics: '[00:01.00] cached LRC fallback',
        lyricsfile: "version: '1.0'\nmetadata: [broken",
    });
    const malformedProvider = new LyricsProvider({
        apiUrl: 'not a valid URI',
        cacheRoot: malformedRoot,
        requestSpacingMs: 0,
    });
    const malformedDocument = await providerFetch(malformedProvider, trackA);
    assert(malformedDocument?.source === 'lrclib-synced' &&
        malformedDocument.lines[0].text === 'cached LRC fallback',
    'a malformed cached Lyricsfile should fall back to cached syncedLyrics');
    malformedProvider.destroy();

    const configRoot = GLib.build_filenamev([tempRoot, 'config']);
    let offsetNow = 100;
    const offsets = new OffsetStore({
        configRoot,
        maxEntries: 2,
        now: () => offsetNow++,
    });
    await offsets.ready();
    offsets.set(trackA, 1000);
    offsets.set(trackB, -500);
    await offsets.flush();
    offsets.destroy();

    const reloadedOffsets = new OffsetStore({configRoot, maxEntries: 2});
    await reloadedOffsets.ready();
    assert(reloadedOffsets.get(trackA) === 1000 &&
        reloadedOffsets.get(trackB) === -500 &&
        reloadedOffsets.get(trackC) === 0,
    'per-track offsets should survive store recreation and remain isolated');
    reloadedOffsets.set(trackC, 500);
    await reloadedOffsets.flush();
    reloadedOffsets.destroy();

    const pendingRoot = GLib.build_filenamev([tempRoot, 'pending-offsets']);
    const pendingSeed = new OffsetStore({configRoot: pendingRoot});
    await pendingSeed.ready();
    pendingSeed.set(trackA, 1000);
    pendingSeed.set(trackB, -500);
    pendingSeed.set(trackC, 750);
    await pendingSeed.flush();
    pendingSeed.destroy();

    let canceledLoads = 0;
    const canceledOffsets = new OffsetStore({
        configRoot: pendingRoot,
        onLoaded: () => canceledLoads++,
    });
    canceledOffsets.set(trackA, 0);
    canceledOffsets.destroy();
    await canceledOffsets.ready();
    assert(canceledLoads === 0,
        'destroying a store during load must not notify its former owner');
    const afterCanceledOffsets = new OffsetStore({configRoot: pendingRoot});
    await afterCanceledOffsets.ready();
    assert(afterCanceledOffsets.get(trackA) === 1000,
        'destroying a pending reset must leave the saved offset unchanged');
    await afterCanceledOffsets.flush();
    afterCanceledOffsets.destroy();

    const pendingOffsets = new OffsetStore({configRoot: pendingRoot});
    pendingOffsets.set(trackA, 0);
    pendingOffsets.set(trackA, 500);
    pendingOffsets.set(trackA, 0);
    pendingOffsets.set(trackB, 0);
    pendingOffsets.set(trackB, 250);
    await pendingOffsets.ready();
    assert(pendingOffsets.get(trackA) === 0 &&
        pendingOffsets.get(trackB) === 250 &&
        pendingOffsets.get(trackC) === 750,
    'pre-load reset and later adjustment must override saved offsets without clearing other tracks');
    await pendingOffsets.flush();
    pendingOffsets.destroy();

    const persistedPending = new OffsetStore({configRoot: pendingRoot});
    await persistedPending.ready();
    assert(persistedPending.get(trackA) === 0 &&
        persistedPending.get(trackB) === 250 &&
        persistedPending.get(trackC) === 750,
    'reset and adjustment made during loading must remain persisted after recreation');
    await persistedPending.flush();
    persistedPending.destroy();

    const providerRoot = GLib.build_filenamev([tempRoot, 'provider-cache']);
    const providerOptions = {
        apiUrl,
        cacheRoot: providerRoot,
        requestSpacingMs: 0,
        timeoutSeconds: 2,
    };
    const firstProvider = new LyricsProvider(providerOptions);
    const firstDocument = await providerFetch(firstProvider, trackA);
    assert(firstDocument?.lines?.[0]?.text === 'persistent line' &&
        networkRequests === 1,
        'the first provider load should use LRCLIB');
    const providerCachePath = GLib.build_filenamev([
        providerRoot, 'lyrics', `${trackHash(trackA)}.json`,
    ]);
    await waitForFile(providerCachePath);
    firstProvider.destroy();

    const secondProvider = new LyricsProvider(providerOptions);
    const diskDocument = await providerFetch(secondProvider, trackA);
    assert(diskDocument?.lines?.[0]?.text === 'persistent line' &&
        networkRequests === 1,
        'provider recreation should use L2 without another LRCLIB request');

    const noLyricsTrack = {...trackA, title: 'No Lyrics'};
    assert(await providerFetch(secondProvider, noLyricsTrack) === null &&
        networkRequests === 2,
    'the first no-lyrics lookup should reach LRCLIB');
    const negativePath = GLib.build_filenamev([
        providerRoot, 'lyrics', `${trackHash(noLyricsTrack)}.json`,
    ]);
    await waitForFile(negativePath);
    secondProvider.destroy();

    const thirdProvider = new LyricsProvider(providerOptions);
    assert(await providerFetch(thirdProvider, noLyricsTrack) === null &&
        networkRequests === 2,
    'a fresh provider should reuse a persistent negative result');

    await clearLyricsCache(providerRoot);
    await thirdProvider.clearCaches();
    const afterClear = await providerFetch(thirdProvider, trackA);
    assert(afterClear?.lines?.[0]?.text === 'persistent line' &&
        networkRequests === 3,
        'clearing L1 and L2 should force the next LRCLIB request');
    thirdProvider.destroy();

    await removeTree(Gio.File.new_for_path(tempRoot));
}

run()
    .catch(error => (scenarioError = error))
    .finally(() => loop.quit());
loop.run();

server.disconnect();
if (scenarioError)
    throw scenarioError;

print('Persistent lyrics cache, expiry, corruption, clear and offset tests passed');
