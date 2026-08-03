/**
 * NDJSON Parser Tests
 * 测试 NDJSON 流式解析器
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const { parseNDJSON, isParseError } = await import('../dist/utils/ndjson-parser.js');

/** Helper: collect all items from async iterable */
async function collect(iterable) {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

test('parseNDJSON parses valid JSON lines', async () => {
  const stream = new PassThrough();
  stream.end('{"a":1}\n{"b":2}\n{"c":3}\n');

  const results = await collect(parseNDJSON(stream));
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { a: 1 });
  assert.deepEqual(results[1], { b: 2 });
  assert.deepEqual(results[2], { c: 3 });
});

test('parseNDJSON skips blank lines', async () => {
  const stream = new PassThrough();
  stream.end('{"a":1}\n\n\n{"b":2}\n  \n');

  const results = await collect(parseNDJSON(stream));
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { a: 1 });
  assert.deepEqual(results[1], { b: 2 });
});

test('parseNDJSON preserves valid top-level null records', async () => {
  const stream = new PassThrough();
  stream.end('null\n\nnull');

  assert.deepEqual(await collect(parseNDJSON(stream)), [null, null]);
});

test('parseNDJSON yields parse error for invalid JSON', async () => {
  const stream = new PassThrough();
  stream.end('{"valid":true}\nnot-json\n{"also":"valid"}\n');

  const results = await collect(parseNDJSON(stream));
  assert.equal(results.length, 3);

  assert.deepEqual(results[0], { valid: true });
  assert.equal(isParseError(results[1]), true);
  assert.equal(results[1].line, 'not-json');
  assert.deepEqual(results[2], { also: 'valid' });
});

test('isParseError returns true for parse errors', () => {
  assert.equal(isParseError({ __parseError: true, line: 'x', error: 'e' }), true);
});

test('isParseError returns false for non-errors', () => {
  assert.equal(isParseError({ type: 'text' }), false);
  assert.equal(isParseError(null), false);
  assert.equal(isParseError('string'), false);
  assert.equal(isParseError(42), false);
  assert.equal(isParseError({ __parseError: false }), false);
});

test('parseNDJSON handles empty stream', async () => {
  const stream = new PassThrough();
  stream.end('');

  const results = await collect(parseNDJSON(stream));
  assert.equal(results.length, 0);
});

test('parseNDJSON handles stream with only whitespace', async () => {
  const stream = new PassThrough();
  stream.end('  \n\n  \n');

  const results = await collect(parseNDJSON(stream));
  assert.equal(results.length, 0);
});

test('parseNDJSON handles chunked writes', async () => {
  const stream = new PassThrough();

  // Simulate chunked writing (like real CLI output)
  const promise = collect(parseNDJSON(stream));
  stream.write('{"type":"sta');
  stream.write('rt"}\n');
  stream.write('{"type":"end"}\n');
  stream.end();

  const results = await promise;
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: 'start' });
  assert.deepEqual(results[1], { type: 'end' });
});

test('parseNDJSON frames only on LF and preserves Unicode line separators', async () => {
  const stream = new PassThrough();
  const first = { text: 'before\u2028middle\u2029after', emoji: '☕' };
  const second = { type: 'final-without-newline' };
  const bytes = Buffer.from(`${JSON.stringify(first)}\r\n${JSON.stringify(second)}`);
  const emojiOffset = bytes.indexOf(Buffer.from('☕'));

  const promise = collect(parseNDJSON(stream));
  stream.write(bytes.subarray(0, emojiOffset + 1));
  stream.end(bytes.subarray(emojiOffset + 1));

  assert.deepEqual(await promise, [first, second]);
});
