import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageSearchMatchEvidence } from '../../dist/domains/memory/message-search-match-evidence.js';

test('match evidence distinguishes Latin names from substrings while allowing adjacent Chinese prose', () => {
  assert.deepEqual(messageSearchMatchEvidence('Sol Mira 起名', 'console.log Mira起名的讨论。', 'hybrid'), {
    kind: 'literal',
    terms: ['Mira', '起名'],
  });
});

test('lexical normalization without an original spelling is never called a semantic hit', () => {
  assert.deepEqual(messageSearchMatchEvidence('café', 'cafe original source', 'lexical'), {
    kind: 'lexical',
    terms: [],
  });
});

test('overlapping literal terms remain query words rather than fabricated semantic support', () => {
  assert.deepEqual(messageSearchMatchEvidence('山川 川 林海', '山川原文', 'hybrid'), {
    kind: 'literal',
    terms: ['山川', '川'],
  });
});
