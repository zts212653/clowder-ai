/** Canonical History still resolves an exact execution after its transient key index expires. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { RedisInvocationRecordStore } from '../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { InvocationKeys } from '../dist/domains/cats/services/stores/redis-keys/invocation-keys.js';
import { TurnExecutionKeys } from '../dist/domains/cats/services/stores/redis-keys/turn-execution-keys.js';
import { canonicalActionFixture, refreshed, unavailable } from './helpers/canonical-action-history-fixtures.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-action-history');
async function fixture(t) {
  const redis = owned.client(`action-history:${randomUUID()}:`);
  t.after(() => redis.disconnect());
  const records = new RedisInvocationRecordStore(redis);
  const turns = new RedisTurnExecutionStore(redis);
  const f = await canonicalActionFixture({ legacyKey: true, stores: { records, turns } });
  const run = f.executions.get('codex-sol');
  const parent = await records.get(run.parentId);
  const indexKey = InvocationKeys.idempotency(f.current.holderThreadId, f.current.tenantScope, parent.idempotencyKey);
  return { ...f, redis, run, parent, indexKey };
}

test('transient lookup index expires; canonical parent and child records remain persistent', async (t) => {
  const f = await fixture(t);
  const ttl = await f.redis.ttl(f.indexKey);
  assert.ok(ttl > 0 && ttl <= 300);
  assert.equal(await f.redis.ttl(InvocationKeys.detail(f.run.parentId)), -1);
  assert.equal(await f.redis.ttl(TurnExecutionKeys.record(f.run.childId)), -1);
  assert.equal(Object.hasOwn(f.admitted.message, 'queueCustody'), false);
  assert.deepEqual(await f.queue.listAllDurable(f.current.holderThreadId), []);
});

test('expired index and reopened execution stores resolve through canonical source/response/child/parent', async (t) => {
  const f = await fixture(t);
  await f.redis.pexpire(f.indexKey, 50);
  await sleep(200);
  const records = new RedisInvocationRecordStore(f.redis);
  const turns = new RedisTurnExecutionStore(f.redis);
  assert.equal(
    await records.getByIdempotencyKey(f.current.holderThreadId, f.current.tenantScope, f.parent.idempotencyKey),
    null,
  );
  assert.equal((await records.get(f.run.parentId)).status, 'succeeded');
  assert.equal(await records.get(f.run.childId), null);
  assert.deepEqual(await f.resolve({ invocationRecordStore: records, turnExecutionStore: turns }), refreshed(f));
});

test('a different immutable generation cannot borrow this persisted execution', async (t) => {
  const f = await fixture(t);
  const foreign = {
    ...f.parent,
    idempotencyKey: 'different-generation',
    actionLeaseCarrier: { ...f.parent.actionLeaseCarrier, generation: f.current.generation + 1 },
  };
  assert.deepEqual(
    await f.resolve({ invocationRecordStore: { get: async () => foreign } }),
    unavailable('carrier_missing'),
  );
  assert.equal((await f.records.get(f.run.parentId)).idempotencyKey, f.parent.idempotencyKey);
});
