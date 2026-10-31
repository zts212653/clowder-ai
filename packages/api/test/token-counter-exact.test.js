import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodingForModel, getEncodingNameForModel } from 'js-tiktoken';
import { countBytePairTokens } from '../dist/utils/ordinary-token-counter.js';
import { estimateTokens, estimateTokensFromMessages } from '../dist/utils/token-counter.js';

const reference = encodingForModel('gpt-4o');
const originalCount = (text) => reference.encode(text, [], []).length;

function exhaustiveCount(piece, ranks) {
  if (ranks.has(piece)) return 1;
  const parts = Array.from(piece);
  while (parts.length > 1) {
    let bestRank = Infinity;
    let bestIndex = -1;
    for (let i = 0; i < parts.length - 1; i++) {
      const rank = ranks.get(parts[i] + parts[i + 1]);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    parts.splice(bestIndex, 2, parts[bestIndex] + parts[bestIndex + 1]);
  }
  return parts.length;
}

function random(seed) {
  let state = seed;
  return (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

function populateRanks(ranks, piece, pick) {
  for (let i = 0; i < piece.length; i++) {
    for (let width = 2; width <= 8 && i + width <= piece.length; width++) {
      if (pick(3) === 0) ranks.set(piece.slice(i, i + width), pick(20));
    }
  }
}

describe('exact ordinary-token budget contract', () => {
  it('keeps the existing gpt-4o vocabulary, not the old misleading cl100k comment', () => {
    assert.equal(getEncodingNameForModel('gpt-4o'), 'o200k_base');
  });

  it('matches original counts across regex, Unicode and control-literal boundaries', () => {
    const cases = [
      '',
      'Hello, world!',
      ' leading trailing  ',
      '\t\r\n \n\r',
      "we're I'M I'LL can't CAN'T rock'n'roll",
      '12345678901234567890',
      '验收填充文字'.repeat(60),
      'aaaaaaaa'.repeat(32),
      'ababab'.repeat(40),
      '你好 world！日本語と한국어 русский Ελληνικά العربية हिन्दी',
      '𠮷野家 🐱👩🏽‍💻🏳️‍🌈 e\u0301 \u200d \u0000',
      '\ud800x\udc00\ud800\ud800\udc00',
      '<|endoftext|> <|fim_prefix|> <|endofprompt|> <|im_start|>',
      'const x = "世界";\n// code\n\n@opus\n```\n@codex\n```',
    ];
    for (const text of cases) assert.equal(estimateTokens(text), originalCount(text), JSON.stringify(text));
  });

  it('matches 300 deterministic multilingual inputs without sharing implementation state', () => {
    const pick = random(0xf117);
    const alphabet = [
      'a',
      'b',
      'Z',
      '0',
      ' ',
      '\n',
      '\t',
      '验',
      '猫',
      '文字',
      '𠮷',
      '🐾',
      '\ud800',
      '\udc00',
      'é',
      '\u0301',
      '\u200d',
      '-',
      '.',
      '/',
      "'",
      'Ж',
      'ع',
      'क',
    ];
    for (let i = 0; i < 300; i++) {
      let text = '';
      const length = 1 + pick(150);
      for (let j = 0; j < length; j++) text += alphabet[pick(alphabet.length)];
      assert.equal(estimateTokens(text), originalCount(text), `seed case ${i}: ${JSON.stringify(text)}`);
    }
  });

  it('truncates every field in UTF-16 before counting, preserving split-surrogate behavior', () => {
    const messages = [
      {
        content: '猫🐾<|endoftext|>尾',
        contentBlocks: [
          { type: 'text', text: '𠮷野家 e\u0301' },
          { type: 'image', text: 'ignored' },
          { type: 'text', text: 'second block' },
        ],
      },
      { content: '' },
    ];
    for (const limit of [0, 1, 2, 3, 5, 100]) {
      const expected =
        originalCount(messages[0].content.slice(0, limit)) +
        originalCount(messages[0].contentBlocks[0].text.slice(0, limit)) +
        originalCount(messages[0].contentBlocks[2].text.slice(0, limit));
      assert.equal(estimateTokensFromMessages(messages, limit), expected, `limit ${limit}`);
    }
  });
});

describe('rank queue agrees with exhaustive byte-pair merging', () => {
  it('chooses the leftmost equal-rank candidate', () => {
    const ranks = new Map([
      ['a', 100],
      ['b', 101],
      ['c', 102],
      ['d', 103],
      ['e', 104],
      ['ab', 1],
      ['bc', 1],
      ['cd', 2],
      ['bcd', 2],
      ['bcde', 3],
    ]);
    assert.equal(exhaustiveCount('abcde', ranks), 3);
    assert.equal(countBytePairTokens('abcde', ranks, 4), 3);
  });

  it('recomputes both neighbors and rejects candidates invalidated at either boundary', () => {
    const ranks = new Map([
      ['a', 100],
      ['b', 101],
      ['c', 102],
      ['d', 103],
      ['e', 104],
      ['ab', 4],
      ['bc', 1],
      ['cd', 3],
      ['abc', 2],
      ['abcd', 5],
      ['de', 2],
    ]);
    for (const text of ['abc', 'abcd', 'abcde', 'abcabcde', 'edcba', 'abcdeabcde']) {
      assert.equal(countBytePairTokens(text, ranks, 4), exhaustiveCount(text, ranks), text);
    }
  });

  it('matches 500 seeded synthetic vocabularies, including equal ranks and binary bytes', () => {
    const pick = random(0xb9e);
    const alphabet = ['\x00', '\x80', '\xff', 'a', 'b'];
    for (let sample = 0; sample < 500; sample++) {
      const ranks = new Map(alphabet.map((byte, i) => [byte, 100 + i]));
      let piece = '';
      for (let i = 0; i < 30; i++) piece += alphabet[pick(alphabet.length)];
      populateRanks(ranks, piece, pick);
      assert.equal(countBytePairTokens(piece, ranks, 8), exhaustiveCount(piece, ranks), `vocabulary ${sample}`);
    }
  });
});
