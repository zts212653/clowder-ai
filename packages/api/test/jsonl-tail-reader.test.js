import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { readJsonlTail } = await import('../dist/utils/jsonl-tail-reader.js');

function makeJsonlFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-tail-'));
  const path = join(dir, 'session.jsonl');
  const lines = entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
  const lastIsRaw = entries.length > 0 && typeof entries[entries.length - 1] === 'string';
  writeFileSync(path, lines.join('\n') + (lastIsRaw ? '' : '\n'));
  return path;
}

describe('readJsonlTail', () => {
  test('returns latest matching entry', () => {
    const path = makeJsonlFile([
      { type: 'gemini', content: 'old', tokens: { input: 100 } },
      { type: 'user', content: 'middle' },
      { type: 'gemini', content: 'new', tokens: { input: 200 } },
    ]);

    const result = readJsonlTail(path, {
      predicate: (m) => m?.type === 'gemini' && typeof m?.tokens?.input === 'number',
    });

    assert.equal(result?.tokens?.input, 200);
  });

  test('skips a partial last line while Gemini is still writing', () => {
    const path = makeJsonlFile([
      { type: 'gemini', content: 'complete', tokens: { input: 50 } },
      '{"type":"gemini","content":"partial","tokens":{"input":',
    ]);

    const result = readJsonlTail(path, {
      predicate: (m) => m?.type === 'gemini' && typeof m?.tokens?.input === 'number',
    });

    assert.equal(result?.tokens?.input, 50);
  });

  test('preserves multi-byte UTF-8 when a line spans chunks', () => {
    const longCjk = '汉'.repeat(3000);
    const path = makeJsonlFile([
      { type: 'user', content: 'first' },
      { type: 'gemini', content: longCjk, tokens: { input: 12345 } },
      { type: 'user', content: 'last' },
    ]);

    const result = readJsonlTail(path, {
      predicate: (m) => m?.type === 'gemini' && m?.content === longCjk,
    });

    assert.equal(result?.tokens?.input, 12345);
  });

  test('respects maxBytes budget instead of scanning the whole file', () => {
    const front = { type: 'gemini', content: 'oldest', tokens: { input: 4242 } };
    const padding = Array.from({ length: 5000 }, (_, i) => ({
      type: 'user',
      content: `pad-${i}`.padEnd(100, 'x'),
    }));
    const path = makeJsonlFile([front, ...padding]);

    const result = readJsonlTail(path, {
      maxBytes: 16 * 1024,
      predicate: (m) => m?.type === 'gemini' && typeof m?.tokens?.input === 'number',
    });

    assert.equal(result, undefined);
  });

  test('returns undefined for missing files', () => {
    assert.equal(readJsonlTail('/no/such/file.jsonl', { predicate: () => true }), undefined);
  });
});
