import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import {
  createMemoryThreadKvPort,
  redisMemoryThreadKvBacking,
  transientMemoryThreadKvBacking,
} from '../dist/domains/plugin/host-surface/memory/memory-thread-kv.js';

function setup() {
  const calls = [];
  const pluginInstanceId = 'memory-instance';
  let active = true;
  const port = createMemoryThreadKvPort({
    pluginInstanceId,
    ownerUserId: 'owner',
    threads: { get: async (threadId) => (threadId === 'owned' ? { createdBy: 'owner' } : null) },
    assertActivation: () => assert.ok(active, 'active memory generation'),
    backing: redisMemoryThreadKvBacking({
      hget: async (...args) => {
        calls.push(args);
        return null;
      },
      hgetall: async (...args) => {
        calls.push(args);
        return {};
      },
      eval: async (_script, ...args) => {
        calls.push(args);
        return 1;
      },
      hdel: async (...args) => {
        calls.push(args);
        return 1;
      },
    }),
  });
  return {
    port,
    calls,
    retire: () => {
      active = false;
    },
    invoke: (userId, threadId, run, instanceId = pluginInstanceId) =>
      withPluginCallContext(
        instanceId,
        { userId, threadId, catId: 'user', invocationId: 'request', assertCurrent: async () => {} },
        run,
      ),
  };
}

test('memory plugin receives raw values only for the authenticated thread and live activation', async () => {
  const { port, calls, invoke, retire } = setup();
  await assert.rejects(port.list('owned'), /memory_thread_access_denied/);
  await assert.rejects(
    invoke('other-user', 'owned', () => port.get('owned', 'key')),
    /memory_thread_access_denied/,
  );
  await assert.rejects(
    invoke('owner', 'other', () => port.list('owned')),
    /memory_thread_access_denied/,
  );
  await assert.rejects(
    invoke('owner', 'owned', () => port.list('owned'), 'other-instance'),
    /memory_thread_access_denied/,
  );
  assert.deepEqual(calls, []);

  await invoke('owner', 'owned', () => port.list('owned'));
  assert.deepEqual(calls, [['cat-cafe:memory:owned']]);

  retire();
  await assert.rejects(
    invoke('owner', 'owned', () => port.delete('owned', 'key')),
    /active memory generation/,
  );
  assert.equal(calls.length, 1);
});

test('explicit transient deployments preserve raw records across activations in the same Host', async () => {
  const backing = transientMemoryThreadKvBacking();
  const hash = 'cat-cafe:memory:owned';
  assert.equal(await backing.compareAndSet(hash, {}, { set: { key: 'a', value: 'first' } }), true);
  assert.equal(await backing.compareAndSet(hash, {}, { set: { key: 'a', value: 'stale' } }), false);
  assert.deepEqual(await backing.list(hash), { a: 'first' });
  assert.equal(await backing.get('cat-cafe:memory:other', 'a'), null);
  assert.equal(await backing.delete(hash, 'a'), true);
  assert.deepEqual(await backing.list(hash), {});
});

test('deployment default uses the fixed legacy hash and only the deployment owner can mutate it', async () => {
  const { port, calls, invoke } = setup();
  const change = { set: { key: 'new', value: '{"value":"raw"}' }, removeKey: 'old' };
  await assert.rejects(
    invoke('other-user', 'default', () => port.compareAndSet('default', { old: 'original' }, change)),
    /memory_thread_access_denied/,
  );
  assert.deepEqual(calls, []);
  assert.equal(
    await invoke('owner', 'default', () => port.compareAndSet('default', { old: 'original' }, change)),
    true,
  );
  assert.deepEqual(calls, [[1, 'cat-cafe:memory:default', '[["old","original"]]', 'new', '{"value":"raw"}', 'old']]);
});
