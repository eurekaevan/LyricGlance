const DEFAULT_MAX_CHUNK_LINES = 20;
const DEFAULT_MAX_CHUNK_CHARS = 3000;

export function buildTranslationChunks(document, {
    maxLines = DEFAULT_MAX_CHUNK_LINES,
    maxChars = DEFAULT_MAX_CHUNK_CHARS,
    contextLines = 2,
} = {}) {
    const translatable = document?.lines
        ?.filter(line => typeof line.text === 'string' && line.text.trim()) ?? [];
    if (translatable.length === 0)
        return [];

    const lineLimit = Math.max(1, Math.floor(maxLines));
    const charLimit = Math.max(1, Math.floor(maxChars));
    const lines = translatable.map(line => ({id: line.lineId, text: line.text}));
    const chars = [0];
    for (const line of lines)
        chars.push(chars.at(-1) + line.text.length);

    // Calculate the minimum number of bounded chunks needed by every suffix.
    // This lets balancing reserve enough capacity for the remaining lines.
    // A single oversized line stays intact in its own chunk.
    const ends = new Array(lines.length);
    const minimumChunks = new Array(lines.length + 1).fill(0);
    for (let start = lines.length - 1; start >= 0; start--) {
        let end = start + 1;
        while (end < lines.length && end - start < lineLimit &&
            chars[end + 1] - chars[start] <= charLimit)
            end++;
        ends[start] = end;
        minimumChunks[start] = 1 + minimumChunks[end];
    }

    const chunks = [];
    let start = 0;
    for (let remaining = minimumChunks[0]; remaining > 0; remaining--) {
        const targetLines = (lines.length - start) / remaining;
        const targetChars = (chars.at(-1) - chars[start]) / remaining;
        let bestEnd = start + 1;
        let bestScore = Infinity;
        for (let end = start + 1; end <= ends[start]; end++) {
            if (minimumChunks[end] > remaining - 1 ||
                lines.length - end < remaining - 1)
                continue;
            const score = Math.abs(end - start - targetLines) / lineLimit +
                Math.abs(chars[end] - chars[start] - targetChars) / charLimit;
            if (score < bestScore) {
                bestScore = score;
                bestEnd = end;
            }
        }
        chunks.push(lines.slice(start, bestEnd));
        start = bestEnd;
    }

    return chunks.map((lines, index) => ({
        index,
        lines,
        contextBefore: index === 0
            ? []
            : chunks[index - 1].slice(-contextLines),
        contextAfter: index === chunks.length - 1
            ? []
            : chunks[index + 1].slice(0, contextLines),
    }));
}
