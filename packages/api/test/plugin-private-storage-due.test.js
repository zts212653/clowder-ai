import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPluginStorageHost,
  RedisPluginPrivateStorage,
} from '../dist/domains/plugin/host-surface/plugin-private-storage.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { auditRecoveryRedis } from './helpers/recovery-store-audit.js';

const fixture = ownedRedisFixture('1843-private-storage-due');
function setup() {
  const redis = fixture.client(`${randomUUID()}:`),
    adapter = new RedisPluginPrivateStorage(redis);
  return { redis, adapter, host: createPluginStorageHost({ pluginId: 'owner/plugin', storage: adapter }) };
}

test('indexed private CAS binds original value/revision/score; stale CAS and old writers have no side effects', async () => {
  const { host } = setup();
  assert.equal((await host.readDue({ index: 'pr-waits', before: 1000, limit: 20 })).status, 'not_ready');
  const value = { id: 'original', recovery: { nextPollAt: 1000, failures: 2 } };
  const first = await host.compareAndSetIndexed('wait', null, value, { index: 'pr-waits', score: 1000 });
  assert.equal(first.applied, true);
  await host.rebuildIndex('pr-waits');
  const before = await host.get('wait');
  assert.deepEqual(before, { revision: first.revision, value });
  assert.equal(
    (await host.compareAndSetIndexed('wait', null, { changed: true }, { index: 'pr-waits', score: 0 })).applied,
    false,
  );
  await assert.rejects(host.set('wait', { changed: true }), /indexed_storage_projection_required/);
  await assert.rejects(
    host.compareAndSet('wait', first.revision, { changed: true }),
    /indexed_storage_projection_required/,
  );
  assert.deepEqual(await host.get('wait'), before);
  assert.deepEqual((await host.readDue({ index: 'pr-waits', before: 999, limit: 20 })).entries, {});
  assert.deepEqual((await host.readDue({ index: 'pr-waits', before: 1000, limit: 20 })).entries, { wait: before });
  const next = await host.compareAndSetIndexed(
    'wait',
    first.revision,
    { ...value, recovery: { nextPollAt: null, failures: 5, disposition: 'needs_attention' } },
    { index: 'pr-waits', score: null },
  );
  assert.equal(next.applied, true);
  await host.rebuildIndex('pr-waits');
  assert.deepEqual((await host.readDue({ index: 'pr-waits', before: 1_000_000, limit: 20 })).entries, {});
  assert.equal((await host.get('wait')).value.recovery.failures, 5);
});

test('actual due reads stay bounded with tenfold retained history and are private to their Host namespace', async () => {
  for (const history of [1000, 10000]) {
    const { redis, adapter, host } = setup();
    const writes = redis.pipeline();
    for (let n = 0; n < history; n++)
      writes.hset('plugin-private-state:v1:owner%2Fplugin', `history-${n}`, `${n + 1}:v:{"status":"done"}`);
    for (const [error] of await writes.exec()) assert.equal(error, null);
    await host.compareAndSetIndexed(
      'pending',
      null,
      { id: 'pending', nextPollAt: 1000 },
      { index: 'pr-waits', score: 1000 },
    );
    await host.rebuildIndex('pr-waits');
    const audit = await auditRecoveryRedis(redis);
    try {
      assert.deepEqual(Object.keys((await host.readDue({ index: 'pr-waits', before: 1000, limit: 1 })).entries), [
        'pending',
      ]);
      await audit.flush();
      audit.assertIndexed();
      assert.equal(
        audit.reads.some(({ command }) => ['hscan', 'hgetall', 'smembers'].includes(command)),
        false,
      );
      assert.ok(audit.reads.length < 15);
    } finally {
      audit.stop();
    }
    const other = createPluginStorageHost({ pluginId: 'different/plugin', storage: adapter });
    await other.rebuildIndex('pr-waits');
    assert.deepEqual((await other.readDue({ index: 'pr-waits', before: 1000, limit: 20 })).entries, {});
    for (const input of [
      { index: '../other', before: 1000, limit: 1 },
      { index: 'pr-waits', before: Infinity, limit: 1 },
      { index: 'pr-waits', before: 1000, limit: 101 },
      { index: 'pr-waits', before: 1000, limit: 0 },
    ])
      await assert.rejects(host.readDue(input), TypeError);
  }
});

test('a missing derived index reports not_ready; rebuilding retains original identity and recovery facts', async () => {
  const { redis, host } = setup();
  await host.compareAndSetIndexed('wait', null, { id: 'same', failures: 3 }, { index: 'pr-waits', score: 1000 });
  const ready = await host.rebuildIndex('pr-waits'),
    snapshot = await host.get('wait');
  const dueKey = `plugin-private-state:v1:index:owner%2Fplugin:pr-waits:${ready.version}`;
  await redis.del(dueKey);
  assert.equal((await host.readDue({ index: 'pr-waits', before: 1000, limit: 20 })).status, 'not_ready');
  await host.rebuildIndex('pr-waits');
  assert.deepEqual((await host.readDue({ index: 'pr-waits', before: 1000, limit: 20 })).entries.wait, snapshot);
  assert.deepEqual(await host.get('wait'), snapshot);
});

test('wrong-typed projection publication cannot commit value or revision first', async () => {
  const { redis, host } = setup();
  const first = await host.compareAndSetIndexed('wait', null, { id: 'same' }, { index: 'pr-waits', score: 1000 });
  const ready = await host.rebuildIndex('pr-waits'),
    snapshot = await host.get('wait');
  await redis.set(`plugin-private-state:v1:index:owner%2Fplugin:pr-waits:${ready.version}`, 'wrong-type');
  await assert.rejects(
    host.compareAndSetIndexed('wait', first.revision, { id: 'overwritten' }, { index: 'pr-waits', score: 2000 }),
    /invalid_plugin_storage_index/,
  );
  assert.deepEqual(await host.get('wait'), snapshot);
});
