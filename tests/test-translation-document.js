import {createLyricsDocument} from '../lyrics-document.js';
import {buildTranslationChunks} from '../translation-batching.js';
import {
    alignTranslation,
    createTranslationDocument,
    languagesEquivalent,
    sourceLyricsLanguage,
    sourceLyricsHash,
    translationCacheKey,
    validateTranslationLines,
} from '../translation-document.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function rejects(callback, message) {
    let rejected = false;
    try {
        callback();
    } catch {
        rejected = true;
    }
    assert(rejected, message);
}

const lyrics = createLyricsDocument({
    source: 'test',
    metadata: {title: 'Context', artist: 'Tester', language: 'en'},
    lines: [
        {text: 'First line', startMs: 1000, endMs: 2000},
        {text: '', startMs: 2000, endMs: 2500},
        {text: 'Repeated', startMs: 2500, endMs: 3000},
        {text: 'Repeated', startMs: 3000, endMs: 3500},
    ],
});
const sameLyrics = createLyricsDocument({
    source: 'different-provider',
    metadata: {title: 'Context', artist: 'Tester', language: 'en'},
    lines: [
        {text: 'First line', startMs: 1000, endMs: 2000},
        {text: '', startMs: 2000, endMs: 2500},
        {text: 'Repeated', startMs: 2500, endMs: 3000},
        {text: 'Repeated', startMs: 3000, endMs: 3500},
    ],
});
assert(lyrics.lines.every(line => line.lineId) &&
    lyrics.lines.map(line => line.lineId).join() ===
        sameLyrics.lines.map(line => line.lineId).join(),
'line IDs should be stable and independent of provider/UI state');
assert(new Set(lyrics.lines.map(line => line.lineId)).size === 4,
    'line index and timing should distinguish repeated text');

const hash = sourceLyricsHash(lyrics);
assert(hash === sourceLyricsHash(sameLyrics),
    'equivalent normalized lyrics should have the same source hash');
const changed = createLyricsDocument({
    source: 'test',
    lines: [{text: 'Changed line', startMs: 1000, endMs: 2000}],
});
assert(sourceLyricsHash(changed) !== hash,
    'a lyrics content change should invalidate the source hash');

const returned = validateTranslationLines(lyrics, {lines: [
    {id: lyrics.lines[2].lineId, text: '重复'},
    {id: lyrics.lines[0].lineId, text: '第一行'},
]});
const translation = createTranslationDocument({
    trackKey: 'track-key',
    sourceLyricsHash: hash,
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    provider: 'mock',
    providerConfiguration: 'mock-endpoint-a',
    model: 'mock-v1',
    lines: returned,
});
const aligned = alignTranslation(lyrics, translation);
assert(aligned[0] === '第一行' && aligned[1] === null &&
    aligned[2] === '重复' && aligned[3] === null,
'alignment should use line IDs and safely leave missing lines untranslated');

rejects(() => validateTranslationLines(lyrics, {
    lines: [{id: 'unknown', text: '错误'}],
}), 'unknown returned IDs must be rejected');
rejects(() => validateTranslationLines(lyrics, {lines: [
    {id: lyrics.lines[0].lineId, text: '一'},
    {id: lyrics.lines[0].lineId, text: '二'},
]}), 'duplicate returned IDs must be rejected');
rejects(() => validateTranslationLines(lyrics, {lines: 'bad'}),
    'malformed translation responses must be rejected');

const cacheOptions = {
    sourceLyricsHash: hash,
    targetLanguage: 'zh-CN',
    provider: 'mock',
    model: 'mock-v1',
};
const key = translationCacheKey(cacheOptions);
assert(key !== translationCacheKey({...cacheOptions, targetLanguage: 'ja'}) &&
    key !== translationCacheKey({...cacheOptions, provider: 'other'}) &&
    key !== translationCacheKey({
        ...cacheOptions,
        providerConfiguration: 'mock-endpoint-b',
    }) &&
    key !== translationCacheKey({...cacheOptions, model: 'mock-v2'}),
'target language, provider configuration, and model must invalidate the cache key');
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

const chunks = buildTranslationChunks(lyrics, {
    maxLines: 2,
    maxChars: 100,
    contextLines: 1,
});
assert(chunks.length === 2 && chunks.every(chunk => chunk.lines.length <= 2) &&
    chunks.flatMap(chunk => chunk.lines.map(line => line.id)).join() ===
        lyrics.lines.filter(line => line.text.trim()).map(line => line.lineId).join() &&
    chunks[0].contextAfter[0].id === chunks[1].lines[0].id &&
    chunks[1].contextBefore[0].id === chunks[0].lines.at(-1).id,
'long lyrics batching should skip blank lines and preserve boundary context');

for (const [name, sizes, expectedChunks, expectedLengths] of [
    ['character-bound tail', Array(16).fill(200), 2, [8, 8]],
    ['line-bound tail', Array(381).fill(5), 20, null],
    ['exact line limit', Array(40).fill(5), 2, [20, 20]],
    ['uneven line lengths', [2500, 100, 100, 100, 100, 2500], 2, [3, 3]],
    ['oversized line', [10, 4000, 10], 3, [1, 1, 1]],
]) {
    const input = {lines: sizes.map((size, index) => ({
        lineId: `line-${index}`, text: 'x'.repeat(size),
    }))};
    const balanced = buildTranslationChunks(input);
    const lengths = balanced.map(chunk => chunk.lines.length);
    assert(balanced.length === expectedChunks &&
        (!expectedLengths || lengths.join() === expectedLengths.join()),
    `${name}: batches should be balanced without creating unnecessary requests`);
    if (name === 'line-bound tail')
        assert(Math.max(...lengths) - Math.min(...lengths) <= 1,
            'many short lines should not leave a one-line trailing request');
    assert(balanced.flatMap(chunk => chunk.lines.map(line => line.id)).join() ===
        input.lines.map(line => line.lineId).join(),
    `${name}: every original line must appear exactly once and in order`);
    for (const [index, chunk] of balanced.entries()) {
        const characters = chunk.lines.reduce((total, line) => total + line.text.length, 0);
        assert(chunk.lines.length <= 20 &&
            (characters <= 3000 || chunk.lines.length === 1),
        `${name}: hard limits must hold except for a single intact oversized line`);
        assert(chunk.contextBefore.map(line => line.id).join() ===
            (balanced[index - 1]?.lines.slice(-2).map(line => line.id).join() ?? '') &&
            chunk.contextAfter.map(line => line.id).join() ===
            (balanced[index + 1]?.lines.slice(0, 2).map(line => line.id).join() ?? ''),
        `${name}: rebalanced boundaries must retain neighboring context`);
    }
}

print('Translation document, alignment, hash and batching tests passed');
