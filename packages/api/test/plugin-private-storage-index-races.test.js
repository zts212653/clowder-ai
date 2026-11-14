import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPluginStorageHost,
  RedisPluginPrivateStorage,
} from '../dist/domains/plugin/host-surface/plugin-private-storage.js';
import { executionFixture } from './helpers/module-execution-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const fixture = ownedRedisFixture('1843-storage-index-races');
const pluginId = 'private/plugin';
const wrap = (adapter) => createPluginStorageHost({ pluginId, storage: adapter });

function proxyRedis(redis, hook) {
  return new Proxy(redis, {
    get(target, method) {
      const value = Reflect.get(target, method, target);
      return method === 'hscan' ? (...args) => hook(...args) : typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('rebuild cannot restore stale members after concurrent cancellation and deletion', async () => {
  const redis = fixture.client(`${randomUUID()}:`),
    host = wrap(new RedisPluginPrivateStorage(redis));
  const first = await host.compareAndSetIndexed(
    'cancelled',
    null,
    { id: 'original', failures: 4 },
    { index: 'waits', score: 1000 },
  );
  const removed = await host.compareAndSetIndexed('deleted', null, { id: 'other' }, { index: 'waits', score: 1000 });
  await host.rebuildIndex('waits');
  let changed = false;
  const raced = wrap(
    new RedisPluginPrivateStorage(
      proxyRedis(redis, async (...args) => {
        const snapshot = await redis.hscan(...args);
        if (!changed) {
          changed = true;
          await host.compareAndSetIndexed(
            'cancelled',
            first.revision,
            { id: 'original', failures: 4, disposition: 'needs_attention' },
            { index: 'waits', score: null },
          );
          assert.equal((await host.delete('deleted', removed.revision)).deleted, true);
        }
        return snapshot;
      }),
    ),
  );
  await raced.rebuildIndex('waits');
  assert.equal(changed, true);
  assert.deepEqual((await host.readDue({ index: 'waits', before: 1000, limit: 20 })).entries, {});
  assert.equal((await host.get('cancelled')).value.failures, 4);
  assert.equal(await host.get('deleted'), undefined);
});

test('interrupted source census is explicitly not_ready and a cold adapter resumes persisted progress', async () => {
  const redis = fixture.client(`${randomUUID()}:`),
    host = wrap(new RedisPluginPrivateStorage(redis));
  const writes = redis.pipeline();
  for (let n = 0; n < 1000; n++)
    writes.hset('plugin-private-state:v1:private%2Fplugin', `history-${n}`, `${n + 1}:v:{"done":true}`);
  for (const [error] of await writes.exec()) assert.equal(error, null);
  await host.compareAndSetIndexed('live', null, { id: 'original', failures: 3 }, { index: 'waits', score: 1000 });
  let pages = 0;
  const interrupted = wrap(
    new RedisPluginPrivateStorage(
      proxyRedis(redis, async (...args) => {
        if (++pages === 2) throw new Error('simulated process loss after persisted first page');
        return redis.hscan(...args);
      }),
    ),
  );
  await assert.rejects(interrupted.rebuildIndex('waits'), /process loss/);
  assert.equal((await host.readDue({ index: 'waits', before: 1000, limit: 20 })).status, 'not_ready');
  const before = await host.get('live');
  const cold = wrap(new RedisPluginPrivateStorage(redis));
  await cold.rebuildIndex('waits');
  assert.deepEqual((await cold.readDue({ index: 'waits', before: 1000, limit: 20 })).entries.live, before);
  assert.deepEqual(await cold.get('live'), before);
});

test('index names/count are bounded and object-shaped keys do not disappear from the result', async () => {
  const redis = fixture.client(`${randomUUID()}:`),
    host = wrap(new RedisPluginPrivateStorage(redis));
  await host.compareAndSetIndexed(
    '__proto__',
    null,
    { id: 'original' },
    { index: 'waits', score: 0, ignored: 'x'.repeat(10000) },
  );
  await host.rebuildIndex('waits');
  const page = await host.readDue({ index: 'waits', before: 1000, limit: 20 });
  assert.equal(Object.hasOwn(page.entries, '__proto__'), true);
  assert.deepEqual(page.entries.__proto__.value, { id: 'original' });
  const raw = await redis.hget('plugin-private-state:v1:private%2Fplugin', '__proto__');
  assert.ok(raw.length < 200, 'only the one declared projection belongs to the canonical envelope');
  for (let n = 1; n < 8; n++) await host.rebuildIndex(`index-${n}`);
  await assert.rejects(
    host.compareAndSetIndexed('limit', null, { id: 'unwritten' }, { index: 'ninth', score: 0 }),
    /plugin_storage_index_limit/,
  );
  assert.equal(await host.get('limit'), undefined);
});

const source = `export default { create() { return { async start(host) { return { actions: {
  write: input => host.storage.compareAndSetIndexed(input.key, null, input.value, input.projection),
  rebuild: () => host.storage.rebuildIndex('waits'),
  due: input => host.storage.readDue(input),
}, stop() {} }; } }; } };`;
test('real execution worker calls indexed storage through the captured Host facade and namespace', async (t) => {
  const redis = fixture.client(`${randomUUID()}:`),
    storage = new RedisPluginPrivateStorage(redis);
  const f = await executionFixture(t, source, { storage });
  await f.runtime.start('instance', f.record);
  assert.equal(
    (
      await f.runtime.invoke('instance', 'write', {
        key: 'wait',
        value: { id: 'worker-original' },
        projection: { index: 'waits', score: 1000 },
      })
    ).applied,
    true,
  );
  await f.runtime.invoke('instance', 'rebuild', {});
  const page = await f.runtime.invoke('instance', 'due', { index: 'waits', before: 1000, limit: 20 });
  assert.equal(page.status, 'ready');
  assert.equal(page.entries.wait.value.id, 'worker-original');
  assert.deepEqual((await storage.get(f.manifest.pluginId, 'wait')).value, { id: 'worker-original' });
  assert.equal(await storage.get('other/plugin', 'wait'), undefined);
  await assert.rejects(
    f.runtime.invoke('instance', 'due', { index: '../foreign', before: 1000, limit: 20 }),
    /invalid plugin storage index/,
  );
});
