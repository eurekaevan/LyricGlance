import {LrcParser} from '../lyrics-parser.js';
import {LyricsSynchronizer} from '../lyrics-synchronizer.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const source = `
[ar:Example]
[offset:+100]
[00:01.00] First line
[00:02.5][00:03.050] Repeated line
[00:04.00]
`;
const lines = LrcParser.parse(source);

assert(lines.length === 4, 'all timestamped lines should be parsed');
assert(lines[0].timeUs === 900_000, 'positive LRC offset should shift lyrics earlier');
assert(lines[1].timeUs === 2_400_000, 'one-digit fractions should mean tenths');
assert(lines[2].timeUs === 2_950_000, 'three-digit fractions should mean milliseconds');
const document = LrcParser.parseDocument(source);
assert(LyricsSynchronizer.currentLineIndex(document, 800) === -1,
    'there should be no lyric before the first timestamp');
const repeatedIndex = LyricsSynchronizer.currentLineIndex(document, 2400);
assert(repeatedIndex === 1 && document.lines[repeatedIndex].text === 'Repeated line',
    'binary search should match an exact timestamp');
const blankIndex = LyricsSynchronizer.currentLineIndex(document, 3900);
assert(blankIndex === 3 && document.lines[blankIndex].text === '',
    'an empty timestamp should clear the previous lyric');
assert(LyricsSynchronizer.currentLineIndex(document, 2950) === 2,
    'the binary search index should identify the exact current entry');

const delayed = LrcParser.parse('[offset: -200]\n[00:01.00] Delayed line');
assert(delayed.length === 1 && delayed[0].timeUs === 1_200_000,
    'negative LRC offset should shift lyrics later');

const bilingual = LrcParser.parse(
    '[00:01.00] Original line\n[00:01.00] Translated line\n[00:01.00]\n[00:01.00] Original line');
assert(bilingual.length === 1 && bilingual[0].text === 'Original line\nTranslated line',
    'same-timestamp bilingual lines should merge without losing original text or duplicating');

const variants = LrcParser.parse(
    '[00:12:34] Colon fraction\r[00:15.00] <00:15.00>Enhanced <00:15.50>words\r[00:20.00] It is [12:00] midnight');
assert(variants.length === 3 &&
    variants[0].timeUs === 12_340_000 && variants[0].text === 'Colon fraction' &&
    variants[1].timeUs === 15_000_000 && variants[1].text === 'Enhanced words' &&
    variants[2].timeUs === 20_000_000 && variants[2].text === 'It is [12:00] midnight',
'colon centiseconds, CR line endings, inline ELRC tags, and mid-line brackets should parse safely');

const overflowOffset = LrcParser.parse(`[offset:-${'9'.repeat(320)}]\n[00:01.00]Finite line`);
assert(overflowOffset.length === 1 && overflowOffset[0].timeUs === 1_000_000,
    'out-of-range LRC offset headers must be ignored rather than overflowing to Infinity');

const manySameTimestamp = LrcParser.parse(
    Array.from({length: 4000}, (_, index) => `[00:01.00]Line ${index}`).join('\n'));
assert(manySameTimestamp.length === 1 &&
    manySameTimestamp[0].text.split('\n').length === 4000,
'large same-timestamp LRC groups must deduplicate in linear time without losing lines');

const excessiveLines = LrcParser.parse(
    Array.from({length: 5005}, (_, index) => `[00:01.${String(index % 1000).padStart(3, '0')}]Line ${index}`).join('\n'));
assert(excessiveLines.length === 0,
    'excessively large LRC files above the line limit must be rejected safely');

print('LRC parser tests passed');
