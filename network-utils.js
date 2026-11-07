import './io-promisify.js';

import GLib from 'gi://GLib';

export const VERSION = '0.9.0';
export const USER_AGENT = `LyricGlance/${VERSION} (lyric-glance@eureka)`;
const READ_CHUNK_BYTES = 64 * 1024;

export class ResponseTooLargeError extends Error {
    constructor() {
        super('response exceeds the size limit');
    }
}

export async function readLimited(stream, limit, cancellable, truncate = false) {
    const chunks = [];
    let total = 0;
    while (!truncate || total < limit) {
        const bytes = await stream.read_bytes_async(
            truncate ? Math.min(READ_CHUNK_BYTES, limit - total) : READ_CHUNK_BYTES,
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
    return contents;
}

export async function closeStream(stream) {
    try {
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    } catch {
        // Preserve the request/decode error rather than a stream-close error.
    }
}
