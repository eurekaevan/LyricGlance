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
assert(lines[0].timeUs === 1_100_000, 'the global offset should be applied');
assert(lines[1].timeUs === 2_600_000, 'one-digit fractions should mean tenths');
assert(lines[2].timeUs === 3_150_000, 'three-digit fractions should mean milliseconds');
const document = LrcParser.parseDocument(source);
assert(LyricsSynchronizer.currentLineIndex(document, 1000) === -1,
    'there should be no lyric before the first timestamp');
const repeatedIndex = LyricsSynchronizer.currentLineIndex(document, 2600);
assert(repeatedIndex === 1 && document.lines[repeatedIndex].text === 'Repeated line',
    'binary search should match an exact timestamp');
const blankIndex = LyricsSynchronizer.currentLineIndex(document, 4100);
assert(blankIndex === 3 && document.lines[blankIndex].text === '',
    'an empty timestamp should clear the previous lyric');
assert(LyricsSynchronizer.currentLineIndex(document, 3150) === 2,
    'the binary search index should identify the exact current entry');

const duplicate = LrcParser.parse('[00:01.00] old\n[00:01.00] new');
assert(duplicate.length === 1 && duplicate[0].text === 'new',
    'the last duplicate timestamp should win');

print('LRC parser tests passed');
