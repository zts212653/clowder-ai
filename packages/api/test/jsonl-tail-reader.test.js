/**
 * RED tests for `readJsonlTail` — reverse-tail JSONL reader used by
 * `readLatestGeminiContextTokens` to avoid full-file readFileSync on
 * potentially-multi-megabyte Gemini local session jsonl files.
 *
 * The current GREEN dependency (parseGeminiSessionFile) loads the whole
 * file with readFileSync + split('\n') on every Gemini invocation
 * completion. For long sessions this is sync I/O on the Node event loop
 * after every model turn. The reverse-tail reader stops as soon as the
 * latest match is found.
 *
 * These tests will fail against the stub implementation that always
 * returns undefined, and pass after the real implementation lands.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { readJsonlTail } = await import('../dist/utils/jsonl-tail-reader.js');

/**
 * Build a temp jsonl file from a list of entries. String entries are written
 * verbatim (use to inject malformed lines). Object entries are JSON.stringified.
 * Adds trailing newline only if the last entry is not a raw string (to allow
 * partial-last-line tests).
 */
function makeJsonlFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-tail-'));
  const path = join(dir, 'session.jsonl');
  const lines = entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
  // Always end with newline UNLESS the last entry was a raw string (caller
  // is simulating a partial write — let it be partial).
  const lastIsRaw = entries.length > 0 && typeof entries[entries.length - 1] === 'string';
  const body = lines.join('\n') + (lastIsRaw ? '' : '\n');
  writeFileSync(path, body);
  return path;
}

describe('readJsonlTail', () => {
  test('returns LATEST matching entry from a small jsonl', () => {
    const path = makeJsonlFile([
      { type: 'user', content: 'first' },
      { type: 'gemini', content: 'reply 1', tokens: { total: 100 } },
      { $set: { lastUpdated: 'x' } },
      { type: 'gemini', content: 'reply 2', tokens: { total: 200 } },
    ]);
    const result = readJsonlTail(path, {
      predicate: (m) =>
        m != null && typeof m === 'object' && m.type === 'gemini' && typeof m.tokens?.total === 'number',
    });
    assert.equal(result?.tokens?.total, 200, 'should return the LATEST gemini-with-tokens, not the first');
  });

  test('returns undefined when no entry matches predicate', () => {
    const path = makeJsonlFile([
      { type: 'user', content: 'only' },
      { $set: { lastUpdated: 'x' } },
      { type: 'gemini', content: 'no tokens here' },
    ]);
    const result = readJsonlTail(path, {
      predicate: (m) => m?.type === 'gemini' && typeof m?.tokens?.total === 'number',
    });
    assert.equal(result, undefined);
  });

  test('tolerates partial last line (CLI mid-write race) — falls back to previous valid entry', () => {
    const path = makeJsonlFile([
      { type: 'gemini', content: 'a', tokens: { total: 50 } },
      // Raw string injected as last entry → no trailing newline → simulates
      // CLI writing the line right now (incomplete JSON).
      '{"type":"gemini","content":"b","tokens":{"total":',
    ]);
    const result = readJsonlTail(path, {
      predicate: (m) => m?.type === 'gemini' && typeof m?.tokens?.total === 'number',
    });
    assert.equal(result?.tokens?.total, 50, 'should skip unparseable last line and return the previous valid entry');
  });

  test('respects maxLines budget — returns undefined when match is older than budget', () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ type: 'user', content: `msg-${i}` }));
    const entries = [{ type: 'gemini', content: 'far_back', tokens: { total: 999 } }, ...filler];
    const path = makeJsonlFile(entries);
    const result = readJsonlTail(path, {
      maxLines: 50,
      predicate: (m) => m?.type === 'gemini' && typeof m?.tokens?.total === 'number',
    });
    assert.equal(result, undefined, 'match buried beyond maxLines budget should return undefined (caller falls back)');
  });

  test('returns undefined for an empty file', () => {
    const path = makeJsonlFile([]);
    const result = readJsonlTail(path, { predicate: () => true });
    assert.equal(result, undefined);
  });

  test('returns undefined for a missing / unreadable file (no throw)', () => {
    const result = readJsonlTail('/no/such/file.jsonl', { predicate: () => true });
    assert.equal(result, undefined, 'missing file should return undefined, not throw');
  });

  test('respects maxBytes budget — bounds total bytes read from tail', () => {
    // Build a ~512 KB jsonl: only entry at the very FRONT, padded user lines
    // after. With a small maxBytes the tail reader must give up before
    // reaching the front match.
    const front = { type: 'gemini', content: 'oldest', tokens: { total: 4242 } };
    const padding = Array.from({ length: 5000 }, (_, i) => ({
      type: 'user',
      content: `pad-${i}`.padEnd(100, 'x'),
    }));
    const path = makeJsonlFile([front, ...padding]);
    const result = readJsonlTail(path, {
      maxBytes: 16 * 1024, // 16 KiB — far less than the file size
      predicate: (m) => m?.type === 'gemini' && typeof m?.tokens?.total === 'number',
    });
    assert.equal(result, undefined, 'must give up after maxBytes; should not read entire file to find front match');
  });

  test('preserves multi-byte UTF-8 (CJK) when a line spans multiple chunks', () => {
    // 3000 CJK chars × 3 bytes ≈ 9 KB → a single line exceeds the 8 KiB
    // default chunk; at least one chunk boundary lands mid-character.
    // The previous per-chunk toString('utf8') would inject U+FFFD into the
    // half-character on each side of the cut, corrupting content and breaking
    // strict-equality predicates used by readLatestGeminiContextTokens.
    const longCjk = '汉'.repeat(3000);
    const target = { type: 'gemini', content: longCjk, tokens: { total: 12345 } };
    const path = makeJsonlFile([
      { type: 'user', content: 'first' },
      target,
      { type: 'user', content: 'last' }, // tail entry is NOT the target — target sits before EOF.
    ]);

    const result = readJsonlTail(path, {
      predicate: (m) =>
        m != null &&
        typeof m === 'object' &&
        m.type === 'gemini' &&
        m.content === longCjk &&
        typeof m.tokens?.total === 'number',
    });
    assert.equal(
      result?.tokens?.total,
      12345,
      'must find target message via strict content equality even when the line spans multiple chunks',
    );
  });

  test('handles a large jsonl by reading from tail (sanity, not perf assertion)', () => {
    // ~5000 padded user lines + 1 gemini at the very end. Real perf assertion
    // (e.g. measuring fs.readSync invocations) is left for follow-up; here we
    // just sanity-check correctness on a multi-MB file.
    const filler = Array.from({ length: 5000 }, (_, i) => ({
      type: 'user',
      content: `msg-${i}`.padEnd(200, 'x'),
    }));
    filler.push({ type: 'gemini', content: 'last', tokens: { total: 7777 } });
    const path = makeJsonlFile(filler);
    const result = readJsonlTail(path, {
      predicate: (m) => m?.type === 'gemini' && typeof m?.tokens?.total === 'number',
    });
    assert.equal(result?.tokens?.total, 7777, 'should find the tail-most matching entry on a large file');
  });
});
