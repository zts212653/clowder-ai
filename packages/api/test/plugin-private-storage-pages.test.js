import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPluginStorageHost,
  RedisPluginPrivateStorage,
} from '../dist/domains/plugin/host-surface/plugin-private-storage.js';

function fixture(pages) {
  const calls = [];
  const redis = {
    async hgetall() {
      assert.fail('a page must not fetch or decode the complete plugin hash');
    },
    async hscan(...args) {
      calls.push(args);
      const page = pages.get(args[1]);
      assert.ok(page, `unexpected cursor ${args[1]}`);
      return page;
    },
  };
  const storage = new RedisPluginPrivateStorage(redis);
  return { storage, calls, host: createPluginStorageHost({ pluginId: 'dev.example/a', storage }) };
}

test('private pages preserve an empty nonterminal Redis page and return only the requested rows', async () => {
  const f = fixture(
    new Map([
      ['0', ['98', []]],
      ['98', ['0', ['github.wait.one', '7:v:{"state":"current"}']]],
    ]),
  );
  const first = await f.host.scan({ prefix: 'github.wait.', count: 2 });
  assert.deepEqual(first, { cursor: '98', entries: {} });
  const second = await f.host.scan({ prefix: 'github.wait.', cursor: first.cursor, count: 2 });
  assert.deepEqual(second, {
    cursor: '0',
    entries: { 'github.wait.one': { revision: 7, value: { state: 'current' } } },
  });
  assert.deepEqual(f.calls, [
    ['plugin-private-state:v1:dev.example%2Fa', '0', 'MATCH', 'github.wait.*', 'COUNT', 2],
    ['plugin-private-state:v1:dev.example%2Fa', '98', 'MATCH', 'github.wait.*', 'COUNT', 2],
  ]);
});

test('a plugin prefix is literal Redis data, not a glob or a route to another plugin', async () => {
  const f = fixture(new Map([['0', ['0', []]]]));
  await f.host.scan({ prefix: 'literal[*?]\\', count: 1 });
  assert.equal(f.calls[0][0], 'plugin-private-state:v1:dev.example%2Fa');
  assert.equal(f.calls[0][3], 'literal\\[\\*\\?\\]\\\\*');
});

test('a roots-only query can select a literal suffix without reading generation payloads', async () => {
  const f = fixture(new Map([['0', ['0', []]]]));
  await f.host.scan({ prefix: 'github.pr-index.v1.', suffix: '.root[*?]', count: 2 });
  assert.equal(f.calls[0][3], 'github.pr-index.v1.*.root\\[\\*\\?\\]');
});

test('page inputs fail before Redis and a malformed selected record remains an error', async () => {
  const f = fixture(new Map([['0', ['0', ['target', 'invalid']]]]));
  for (const input of [
    { prefix: 'x', cursor: '-1' },
    { prefix: 'x', cursor: '1 MATCH *' },
    { prefix: 'x', count: 0 },
    { prefix: 'x', count: 1.5 },
    { prefix: 'x', count: 201 },
    { prefix: 'x'.repeat(257) },
  ]) {
    await assert.rejects(f.host.scan(input), TypeError);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.host.scan({ prefix: 'target' }), /malformed/);
});
