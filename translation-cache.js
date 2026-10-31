import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {defaultCacheRoot, readJson, removeTree, writeJson} from './storage.js';
import {
    createTranslationDocument,
    TRANSLATION_DOCUMENT_VERSION,
    translationCacheKey,
} from './translation-document.js';

const MAX_TRANSLATION_CACHE_ENTRIES = 500;

Gio._promisify(Gio.File.prototype,
    'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype,
    'delete_async', 'delete_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype,
    'close_async', 'close_finish');

function isNotFound(error) {
    return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

async function listFiles(directory, cancellable = null) {
    let enumerator;
    try {
        enumerator = await directory.enumerate_children_async(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            cancellable);
    } catch (error) {
        if (isNotFound(error))
            return [];
        throw error;
    }

    const files = [];
    try {
        while (true) {
            const batch = await enumerator.next_files_async(
                64, GLib.PRIORITY_DEFAULT, cancellable);
            if (batch.length === 0)
                break;
            files.push(...batch.filter(info =>
                info.get_file_type() === Gio.FileType.REGULAR &&
                info.get_name().endsWith('.json')));
        }
    } finally {
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
    }
    return files;
}

function defaultTranslationCacheDirectory(
    cacheRoot = defaultCacheRoot()) {
    return GLib.build_filenamev([cacheRoot, 'translations']);
}

export async function clearTranslationCache(
    cacheRoot = defaultCacheRoot(), cancellable = null) {
    await removeTree(Gio.File.new_for_path(
        defaultTranslationCacheDirectory(cacheRoot)), cancellable);
}

export async function countTranslationCache(
    cacheRoot = defaultCacheRoot(), cancellable = null) {
    return (await listFiles(Gio.File.new_for_path(
        defaultTranslationCacheDirectory(cacheRoot)), cancellable)).length;
}

export class TranslationDiskCache {
    constructor({
        cacheRoot = defaultCacheRoot(),
        maxEntries = MAX_TRANSLATION_CACHE_ENTRIES,
        now = () => Date.now(),
    } = {}) {
        this._directory = Gio.File.new_for_path(
            defaultTranslationCacheDirectory(cacheRoot));
        this._maxEntries = Math.max(1, Math.floor(maxEntries));
        this._now = now;
    }

    _fileFor(options) {
        return this._directory.get_child(`${translationCacheKey(options)}.json`);
    }

    async get(options, trackKey, cancellable = null) {
        const file = this._fileFor(options);
        let record;
        try {
            record = await readJson(file, cancellable);
            if (record.version !== TRANSLATION_DOCUMENT_VERSION ||
                record.sourceLyricsHash !== options.sourceLyricsHash ||
                record.targetLanguage !== options.targetLanguage ||
                record.provider !== options.provider ||
                record.providerConfiguration !==
                    options.providerConfiguration ||
                record.model !== options.model)
                return {hit: false};
            const document = createTranslationDocument({
                ...record,
                trackKey,
            });
            record.lastAccessed = this._now();
            writeJson(file, record, cancellable).catch(() => {});
            return {hit: true, document};
        } catch (error) {
            if (!isNotFound(error) &&
                !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug('LyricGlance: ignoring invalid translation cache entry');
            return {hit: false};
        }
    }

    async put(document, cancellable = null) {
        const file = this._fileFor(document);
        await writeJson(file, {
            ...document,
            lines: document.lines.map(line => ({...line})),
            lastAccessed: this._now(),
        }, cancellable);
        await this._evictOldest(cancellable);
    }

    async clear(cancellable = null) {
        await removeTree(this._directory, cancellable);
    }

    async count(cancellable = null) {
        return (await listFiles(this._directory, cancellable)).length;
    }

    async _evictOldest(cancellable = null) {
        const files = await listFiles(this._directory, cancellable);
        if (files.length <= this._maxEntries)
            return;

        const ages = [];
        for (const info of files) {
            let lastAccessed = 0;
            try {
                const record = await readJson(
                    this._directory.get_child(info.get_name()), cancellable);
                lastAccessed = Number(record.lastAccessed) ||
                    Date.parse(record.createdAt) || 0;
            } catch {
                // Invalid entries are evicted first.
            }
            ages.push({name: info.get_name(), lastAccessed});
        }
        ages.sort((left, right) => left.lastAccessed - right.lastAccessed);
        for (const entry of ages.slice(0, ages.length - this._maxEntries)) {
            try {
                await this._directory.get_child(entry.name)
                    .delete_async(GLib.PRIORITY_DEFAULT, cancellable);
            } catch (error) {
                if (!isNotFound(error))
                    throw error;
            }
        }
    }
}
