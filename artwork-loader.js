import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {closeStream, readLimited, USER_AGENT} from './network-utils.js';
import {ensureDirectory, removeTree} from './storage.js';

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LOCAL_FILE_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/bmp',
    'image/x-icon',
    'image/vnd.microsoft.icon',
]);

function isIoError(error, code) {
    return error.matches?.(Gio.IOErrorEnum, code);
}

function urlScheme(url) {
    const match = /^([A-Za-z][A-Za-z\d+.-]*):/.exec(url);
    return match?.[1]?.toLowerCase() ?? '';
}

function isLoopbackHost(host) {
    return LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isDisallowedNetworkHost(host, {allowPrivate = true} = {}) {
    if (!host)
        return true;
    const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (!allowPrivate && normalized === 'localhost')
        return true;
    let address = Gio.InetAddress.new_from_string(normalized);
    if (!address)
        return false;
    const canonical = address.to_string().toLowerCase();
    if (canonical.startsWith('::ffff:')) {
        const mapped = Gio.InetAddress.new_from_string(
            canonical.slice('::ffff:'.length));
        if (mapped)
            address = mapped;
    }
    if (address.get_is_any() || address.get_is_link_local() ||
        address.get_is_multicast())
        return true;
    if (!allowPrivate && (address.get_is_loopback() ||
        address.get_is_site_local() || /^f[cd][0-9a-f]{2}:/.test(canonical)))
        return true;
    return false;
}

function parseRemoteArtworkUri(url, {previousUri = null} = {}) {
    let uri;
    try {
        uri = previousUri
            ? previousUri.parse_relative(url, GLib.UriFlags.NONE)
            : GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch (error) {
        throw new Error(`invalid artwork URL: ${error.message}`);
    }
    const scheme = uri.get_scheme()?.toLowerCase();
    const host = uri.get_host()?.toLowerCase() ?? '';
    if (!['http', 'https'].includes(scheme) || !host || uri.get_userinfo() !== null)
        throw new Error('artwork URL is not allowed');
    if (scheme === 'http' && !LOOPBACK_HOSTS.has(host))
        throw new Error('remote artwork requires HTTPS');
    const prevHost = previousUri?.get_host()?.toLowerCase() ?? '';
    if (previousUri) {
        const prevScheme = previousUri.get_scheme()?.toLowerCase();
        if (prevScheme === 'https' && scheme !== 'https')
            throw new Error('artwork redirect cannot downgrade HTTPS');
    }
    if (isDisallowedNetworkHost(host, {allowPrivate: !previousUri || isLoopbackHost(prevHost)}))
        throw new Error('artwork host is not allowed');
    return uri;
}

function cacheHash(url) {
    return GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256, url, -1);
}

function defaultArtworkCacheDirectory() {
    return GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        'lyric-glance',
        'artwork',
    ]);
}

export async function clearArtworkCache(
    cacheDirectory = defaultArtworkCacheDirectory(), cancellable = null) {
    await removeTree(Gio.File.new_for_path(cacheDirectory), cancellable);
}

export async function countArtworkCache(
    cacheDirectory = defaultArtworkCacheDirectory(), cancellable = null) {
    const directory = Gio.File.new_for_path(cacheDirectory);
    let enumerator;
    try {
        enumerator = await directory.enumerate_children_async(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT,
            cancellable);
    } catch (error) {
        if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
            return 0;
        throw error;
    }

    let count = 0;
    try {
        while (true) {
            const batch = await enumerator.next_files_async(
                64, GLib.PRIORITY_DEFAULT, cancellable);
            if (batch.length === 0)
                break;
            for (const info of batch) {
                if (info.get_file_type() === Gio.FileType.REGULAR &&
                    info.get_name().endsWith('.image'))
                    count++;
            }
        }
    } finally {
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
    }
    return count;
}

export class ArtworkLoader {
    constructor({
        cacheDirectory = defaultArtworkCacheDirectory(),
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
        maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
        timeoutSeconds = 12,
    } = {}) {
        this._cacheDirectory = Gio.File.new_for_path(cacheDirectory);
        this._maxEntries = Math.max(1, Math.floor(maxEntries));
        this._maxTotalBytes = Math.max(1, Math.floor(maxTotalBytes));
        this._maxResponseBytes = Math.max(1, Math.floor(maxResponseBytes));
        this._session = new Soup.Session({
            timeout: timeoutSeconds,
            'idle-timeout': timeoutSeconds,
            'user-agent': USER_AGENT,
        });
        this._maintenanceCancellable = new Gio.Cancellable();
    }

    async load(artUrl, cancellable = null) {
        const url = typeof artUrl === 'string' ? artUrl.trim() : '';
        const scheme = urlScheme(url);
        switch (scheme) {
        case 'file':
            return {
                file: await this._loadLocalFile(url, cancellable),
                fromCache: false,
                remote: false,
            };
        case 'http':
        case 'https':
            return this._loadRemoteFile(url, cancellable);
        default:
            throw new Error(`unsupported artwork URI scheme: ${scheme || 'none'}`);
        }
    }

    discard(file) {
        if (!file || !this._isCacheFile(file) ||
            this._maintenanceCancellable.is_cancelled())
            return;
        file.delete_async(
            GLib.PRIORITY_DEFAULT, this._maintenanceCancellable).catch(() => {});
    }

    destroy() {
        this._session?.abort();
        this._session = null;
        this._maintenanceCancellable.cancel();
    }

    async _loadLocalFile(url, cancellable) {
        let uri;
        try {
            uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        } catch (error) {
            throw new Error(`invalid local artwork URI: ${error.message}`);
        }
        const host = uri.get_host()?.toLowerCase() ?? '';
        if ((host && host !== 'localhost') ||
            uri.get_userinfo() !== null ||
            uri.get_query() !== null ||
            uri.get_fragment() !== null)
            throw new Error('non-local file artwork URI is not allowed');
        const file = Gio.File.new_for_uri(url);
        const info = await file.query_info_async(
            'standard::type,standard::size',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable);
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            throw new Error('artwork URI is not a regular file');
        const size = info.get_size();
        if (size <= 0 || size > MAX_LOCAL_FILE_BYTES)
            throw new Error(`local artwork size is invalid: ${size}`);
        return file;
    }

    async _loadRemoteFile(url, cancellable) {
        if (!this._session)
            throw new Error('artwork loader has been destroyed');
        let currentUri = parseRemoteArtworkUri(url);
        const cacheFile = this._cacheDirectory.get_child(
            `${cacheHash(url)}.image`);
        if (await this._isUsableCacheFile(cacheFile, cancellable)) {
            try {
                await this._touch(cacheFile, cancellable);
            } catch {
                // A usable cached image should survive timestamp failures.
            }
            return {file: cacheFile, fromCache: true, remote: true};
        }

        let contents = null;
        for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
            if (!this._session)
                throw new Error('artwork loader has been destroyed');
            let message;
            try {
                message = Soup.Message.new('GET', currentUri.to_string());
            } catch (error) {
                throw new Error(`invalid artwork URL: ${error.message}`);
            }
            if (!message)
                throw new Error('Soup rejected the artwork URL');
            message.set_flags(Soup.MessageFlags.NO_REDIRECT);

            const stream = await this._session.send_async(
                message, GLib.PRIORITY_DEFAULT, cancellable);
            let nextLocation = null;
            try {
                const status = message.status_code;
                const headers = message.get_response_headers();
                if ([301, 302, 303, 307, 308].includes(status)) {
                    if (redirect === MAX_REDIRECTS)
                        throw new Error('artwork response exceeded redirect limit');
                    nextLocation = headers.get_one('Location');
                    if (!nextLocation)
                        throw new Error(`artwork redirect ${status} missing Location`);
                } else {
                    if (status < 200 || status >= 300)
                        throw new Error(`artwork HTTP status ${status}`);

                    const contentLength = headers.get_content_length();
                    if (contentLength > this._maxResponseBytes)
                        throw new Error('artwork response exceeds the size limit');
                    const rawContentType = headers.get_one('Content-Type') ?? '';
                    const mimeType = rawContentType.split(';')[0].trim().toLowerCase();
                    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
                        throw new Error(
                            `artwork response is not a supported image: ${rawContentType || 'missing'}`);
                    }

                    contents = await readLimited(stream, this._maxResponseBytes, cancellable);
                    if (contents.length === 0)
                        throw new Error('artwork response is empty');
                }
            } finally {
                await closeStream(stream);
            }

            if (nextLocation !== null) {
                currentUri = parseRemoteArtworkUri(nextLocation, {previousUri: currentUri});
                continue;
            }
            break;
        }

        await ensureDirectory(this._cacheDirectory, cancellable);
        await cacheFile.replace_contents_async(
            contents,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            cancellable);

        await this._evictOldest(cancellable, cacheFile.get_basename());
        return {file: cacheFile, fromCache: false, remote: true};
    }

    async _isUsableCacheFile(file, cancellable) {
        try {
            const info = await file.query_info_async(
                'standard::type,standard::size',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable);
            return info.get_file_type() === Gio.FileType.REGULAR &&
                info.get_size() > 0 &&
                info.get_size() <= this._maxResponseBytes;
        } catch (error) {
            if (!isIoError(error, Gio.IOErrorEnum.NOT_FOUND) &&
                !isIoError(error, Gio.IOErrorEnum.CANCELLED))
                console.debug(`LyricGlance: artwork cache read failed: ${error.message}`);
            return false;
        }
    }

    async _touch(file, cancellable) {
        const info = new Gio.FileInfo();
        info.set_attribute_uint64(
            'time::modified', Math.floor(Date.now() / 1000));
        await file.set_attributes_async(
            info,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable);
    }

    async _evictOldest(cancellable, protectedName = null) {
        let enumerator;
        try {
            enumerator = await this._cacheDirectory.enumerate_children_async(
                'standard::name,standard::type,standard::size,time::modified',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT,
                cancellable);
        } catch (error) {
            if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
                return;
            throw error;
        }

        const entries = [];
        try {
            while (true) {
                const batch = await enumerator.next_files_async(
                    64, GLib.PRIORITY_DEFAULT, cancellable);
                if (batch.length === 0)
                    break;
                for (const info of batch) {
                    if (info.get_file_type() !== Gio.FileType.REGULAR ||
                        !info.get_name().endsWith('.image'))
                        continue;
                    entries.push({
                        name: info.get_name(),
                        size: info.get_size(),
                        modified: info.get_attribute_uint64('time::modified'),
                    });
                }
            }
        } finally {
            await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
        }

        entries.sort((left, right) => left.modified - right.modified);
        let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
        let totalEntries = entries.length;
        for (const entry of entries) {
            if (totalEntries <= this._maxEntries &&
                totalBytes <= this._maxTotalBytes)
                break;
            if (entry.name === protectedName)
                continue;
            if (cancellable?.is_cancelled()) {
                throw new GLib.Error(
                    Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled');
            }
            let removed = false;
            try {
                await this._cacheDirectory.get_child(entry.name)
                    .delete_async(GLib.PRIORITY_DEFAULT, cancellable);
                removed = true;
            } catch (error) {
                if (cancellable?.is_cancelled() ||
                    isIoError(error, Gio.IOErrorEnum.CANCELLED))
                    throw error;
                if (isIoError(error, Gio.IOErrorEnum.NOT_FOUND))
                    removed = true;
                else
                    console.debug(`LyricGlance: artwork cache eviction failed: ${error.message}`);
            }
            if (removed) {
                totalEntries--;
                totalBytes -= entry.size;
            }
        }
    }

    _isCacheFile(file) {
        const cachePath = this._cacheDirectory.get_path();
        const path = file.get_path();
        return Boolean(cachePath && path &&
            path.startsWith(`${cachePath}${GLib.DIR_SEPARATOR_S}`));
    }
}
