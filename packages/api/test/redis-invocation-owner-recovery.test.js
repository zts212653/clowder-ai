import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RedisInvocationRecordStore } from '../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { auditRecoveryRedis } from './helpers/recovery-store-audit.js';

const fixture = ownedRedisFixture('1843-invocation-owner');

test('production owner recovery uses a bounded running selector rather than scanAll', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const section = source.slice(
    source.indexOf('const invocationOwnerReaper = new InvocationOwnerReaper'),
    source.indexOf(
      'reconcileZombie: (zombie)',
      source.indexOf('const invocationOwnerReaper = new InvocationOwnerReaper'),
    ),
  );
  assert.doesNotMatch(section, /scanAll/);
  assert.match(section, /listRunningForRecovery/);
});

test('fixed running work costs constant Redis reads with tenfold terminal history; reads rotate only due work', async () => {
  for (const history of [100, 1000]) {
    const redis = fixture.client(`owner-recovery-${history}-${randomUUID()}:`);
    const writes = redis.pipeline();
    for (let n = 0; n < history + 1; n++)
      writes.hset(`invoc:inv-${n}`, {
        id: `inv-${n}`,
        threadId: 'thread',
        userId: 'owner',
        targetCats: '["codex61-sol"]',
        intent: 'execute',
        status: n === 0 ? 'running' : 'succeeded',
        createdAt: '1',
        updatedAt: '2',
        idempotencyKey: `key-${n}`,
        actionLeaseCarrier: '{"kind":"none"}',
      });
    for (const [error] of await writes.exec()) assert.equal(error, null);
    const store = new RedisInvocationRecordStore(redis);
    await store.initializeOwnerRecovery?.();
    const audit = await auditRecoveryRedis(redis);
    try {
      assert.deepEqual(
        (await store.listRunningForRecovery(100, 10_000)).map((record) => record.id),
        ['inv-0'],
      );
      assert.deepEqual(
        await store.listRunningForRecovery(100, 10_000),
        [],
        'selection defers work without consuming failures',
      );
      await audit.flush();
      audit.assertIndexed();
      assert.ok(audit.reads.length < 30, 'only fixed due work may be inspected');
    } finally {
      audit.stop();
    }
    assert.equal((await new RedisInvocationRecordStore(redis).listRunningForRecovery(100, 10_000)).length, 0);
    await store.initializeOwnerRecovery(true);
    assert.equal(
      (await store.listRunningForRecovery(100, 10_000)).length,
      0,
      'rebuild cannot erase the canonical next due time',
    );
    assert.equal((await store.listRunningForRecovery(100, 400_000)).length, 1);
    await store.update('inv-0', { status: 'succeeded' });
    assert.equal((await store.listRunningForRecovery(100, 800_000)).length, 0);
  }
});

test('owner health is durable across clients, metadata-only, finite on errors and reset by a real new attempt', async () => {
  const redis = fixture.client(`owner-health-${randomUUID()}:`);
  const store = new RedisInvocationRecordStore(redis);
  const { invocationId: id } = await store.create({
    threadId: 'home',
    userId: 'owner',
    targetCats: ['codex61-sol'],
    intent: 'execute',
    actionLeaseCarrier: { kind: 'none' },
    idempotencyKey: 'original',
  });
  await store.update(id, { status: 'running' });
  const snapshot = await store.get(id);
  const input = { signature: 'active', silence: true, failed: false };
  assert.deepEqual(await store.observeOwnerRecovery(id, input), { changed: true, silenceNew: true, parked: false });
  const cold = new RedisInvocationRecordStore(redis);
  assert.deepEqual(await cold.observeOwnerRecovery(id, input), { changed: false, silenceNew: false, parked: false });
  assert.deepEqual(await cold.get(id), snapshot);
  for (let n = 0; n < 5; n++)
    await cold.observeOwnerRecovery(id, { signature: 'probe_failed', silence: false, failed: true });
  assert.equal((await cold.getOwnerRecoveryFacts(id)).disposition, 'needs_attention');
  assert.deepEqual(await cold.listRunningForRecovery(), []);
  await cold.initializeOwnerRecovery(true);
  assert.deepEqual(await cold.listRunningForRecovery(), []);
  assert.deepEqual(await cold.get(id), snapshot);
  await store.update(id, { status: 'failed' });
  assert.equal((await cold.getOwnerRecoveryFacts(id)).recordStatus, 'failed');
  await store.update(id, { status: 'running' });
  assert.equal((await store.getOwnerRecoveryFacts(id)).disposition, undefined);
  assert.equal((await cold.listRunningForRecovery()).length, 1);
});

test('malformed running records retain their original bytes and leave due recovery without hiding their neighbor', async () => {
  const redis = fixture.client(`owner-corrupt-${randomUUID()}:`);
  const store = new RedisInvocationRecordStore(redis);
  for (const id of ['bad', 'healthy'])
    await redis.hset(`invoc:${id}`, {
      id,
      threadId: 'home',
      userId: 'owner',
      targetCats: id === 'bad' ? '{invalid original payload' : '["codex61-sol"]',
      status: 'running',
      intent: 'execute',
      createdAt: '1',
      updatedAt: '1',
      idempotencyKey: id,
      actionLeaseCarrier: '{"kind":"none"}',
    });
  assert.deepEqual(
    (await store.listRunningForRecovery()).map((record) => record.id),
    ['healthy'],
  );
  const facts = await store.getOwnerRecoveryFacts('bad');
  assert.equal(facts.disposition, 'needs_attention');
  assert.equal(facts.reasonCode, 'invalid_invocation_record');
  assert.equal(await redis.hget('invoc:bad', 'targetCats'), '{invalid original payload');
  await store.initializeOwnerRecovery(true);
  assert.deepEqual(await store.listRunningForRecovery(), []);
});

test('a wrong-typed owner due index is rejected before the original running transition', async () => {
  const redis = fixture.client(`owner-atomic-${randomUUID()}:`);
  const store = new RedisInvocationRecordStore(redis);
  const { invocationId: id } = await store.create({
    threadId: 'home',
    userId: 'owner',
    targetCats: ['codex61-sol'],
    intent: 'execute',
    actionLeaseCarrier: { kind: 'none' },
    idempotencyKey: 'original',
  });
  const snapshot = await store.get(id);
  await redis.set('invoc-recovery:due', 'invalid index');
  await assert.rejects(store.update(id, { status: 'running' }), /invalid_invocation_owner_recovery_index/);
  assert.deepEqual(await store.get(id), snapshot);
  assert.equal(await redis.scard('invoc:running:home:owner'), 0);
});
