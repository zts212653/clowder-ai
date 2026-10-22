import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coalesceSparseScans } from '../src/scripts/github-approved-source/sparse-scan.js';

test('empty SCAN pages retain every physical cursor and find a late matching key', async () => {
  const calls: string[][] = [];
  const source = {
    async read(command: string, ...args: string[]) {
      assert.equal(command, 'SCAN');
      assert.deepEqual(args.slice(1), ['MATCH', 'approved:notified:*', 'COUNT', '256']);
      calls.push(args);
      const cursor = Number(args[0]);
      return cursor === 2101 ? ['0', ['approved:notified:one']] : [String(cursor + 1), []];
    },
  };
  const reader = coalesceSparseScans(source);
  let cursor = '0';
  const keys: string[] = [];
  let logicalPages = 0;
  do {
    const page = (await reader.read('SCAN', cursor, 'MATCH', 'approved:notified:*', 'COUNT', '256')) as [
      string,
      string[],
    ];
    cursor = page[0];
    keys.push(...page[1]);
    assert.ok(++logicalPages <= 2000);
  } while (cursor !== '0');
  assert.deepEqual(keys, ['approved:notified:one']);
  assert.equal(calls.length, 2102);
  assert.deepEqual(
    calls.map((args) => Number(args[0])),
    Array.from({ length: 2102 }, (_, i) => i),
  );
});

test('SSCAN coalesces only empty pages, stops at a match, and preserves physical rejections', async () => {
  const calls: string[][] = [];
  const reader = coalesceSparseScans({
    async read(command, ...args) {
      if (command !== 'SSCAN') throw new Error('physical command refused');
      calls.push(args);
      assert.deepEqual([args[0], ...args.slice(2)], ['approved:seen', 'MATCH', 'comment:approved/*', 'COUNT', '256']);
      if (calls.length === 1) return ['17', []];
      return ['42', ['comment:approved/one']];
    },
  });
  assert.deepEqual(await reader.read('SSCAN', 'approved:seen', '0', 'MATCH', 'comment:approved/*', 'COUNT', '256'), [
    '42',
    ['comment:approved/one'],
  ]);
  assert.equal(calls[1]?.[1], '17');
  await assert.rejects(reader.read('SET', 'outside', 'value'), /physical command refused/);
});

test('at most eight physical calls run per batch and cancellation is not swallowed', async () => {
  let calls = 0;
  const reader = coalesceSparseScans({
    async read() {
      if (++calls > 8) throw new Error('physical budget refused');
      return [String(calls), []];
    },
  });
  assert.deepEqual(await reader.read('SCAN', '0'), ['8', []]);
  assert.equal(calls, 8);
  await assert.rejects(reader.read('SCAN', '8'), /physical budget refused/);
});
