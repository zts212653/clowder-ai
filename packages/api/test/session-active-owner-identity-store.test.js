import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Redis from 'ioredis';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { RedisSessionChainStore } from '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { SessionChainKeys } from '../dist/domains/cats/services/stores/redis-keys/session-chain-keys.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

// The provider-entry identity fence relies on this read-only check being a single atomic decision.
const input = { catId: 'codex', threadId: 'identity-thread', userId: 'identity-owner' };
const redisUrl = process.env.REDIS_URL;

for (const backend of ['memory', 'redis']) {
  const options = backend === 'redis' ? { skip: redisIsolationSkipReason(redisUrl) } : {};
  function create(t) {
    if (backend === 'memory') return { store: new SessionChainStore() };
    assertRedisIsolationOrThrow(redisUrl, 'session-active-owner-identity');
    const redis = new Redis(redisUrl, { keyPrefix: `active-owner-identity:${randomUUID()}:`, maxRetriesPerRequest: 1 });
    t.after(() => redis.quit()); // Retain test-owned keys; the instance owner saves all data at shutdown.
    return { store: new RedisSessionChainStore(redis), redis };
  }

  test(`${backend}: identity holds only for the active owner with the exact runtime ID`, options, async (t) => {
    const { store } = create(t);
    const record = await store.create(input);
    assert.equal(await store.isActiveOwnerSession(record.id, undefined), true, 'unbound owner');
    assert.equal(await store.isActiveOwnerSession(record.id, 'native-a'), false, 'unbound is not native-a');
    assert.ok(await store.bindCliSessionId(record.id, 'native-a'));
    assert.equal(await store.isActiveOwnerSession(record.id, 'native-a'), true);
    assert.equal(await store.isActiveOwnerSession(record.id, undefined), false);
    assert.equal(await store.isActiveOwnerSession(record.id, 'native-b'), false);
    assert.equal(await store.isActiveOwnerSession('missing-session', undefined), false);
    const before = await store.get(record.id);
    await store.isActiveOwnerSession(record.id, 'native-a');
    assert.deepEqual(await store.get(record.id), before, 'the check writes nothing');
  });

  test(`${backend}: a sealed record is no longer the active owner`, options, async (t) => {
    const { store } = create(t);
    const record = await store.create({ ...input, cliSessionId: 'native-sealed' });
    await store.update(record.id, { status: 'sealed', sealReason: 'manual', sealedAt: Date.now() });
    assert.equal(await store.isActiveOwnerSession(record.id, 'native-sealed'), false);
  });

  test(`${backend}: a cleared owner pointer does not reclaim the displaced previous record`, options, async (t) => {
    const { store, redis } = create(t);
    const previous = await store.create({ ...input, cliSessionId: 'native-previous' });
    const replacement = await store.create({ ...input, cliSessionId: 'native-replacement' });
    await store.update(replacement.id, { status: 'sealed', sealReason: 'manual', sealedAt: Date.now() });
    const ownerPointer = () =>
      backend === 'redis'
        ? redis.get(SessionChainKeys.activeOwner(input.userId, input.catId, input.threadId))
        : store.ownerActiveIndex.get(store.ownerCatThreadKey(input.userId, input.catId, input.threadId));
    const pointerBefore = await ownerPointer();
    assert.notEqual(pointerBefore, previous.id, 'precondition: the previous record no longer owns the pointer');
    const previousBefore = await store.get(previous.id);
    assert.equal(await store.isActiveOwnerSession(previous.id, previousBefore.cliSessionId), false);
    assert.equal(await ownerPointer(), pointerBefore, 'the check does not repair or move the pointer');
    assert.deepEqual(await store.get(previous.id), previousBefore, 'the check writes nothing');
  });

  if (backend === 'redis') {
    test('redis: a replaced owner pointer refuses the still-active previous record', options, async (t) => {
      const { store, redis } = create(t);
      const previous = await store.create({ ...input, cliSessionId: 'native-previous' });
      assert.equal(await store.isActiveOwnerSession(previous.id, 'native-previous'), true);
      // End state of the reviewed interleaving: ownership moved while the previous hash stays active.
      await redis.set(SessionChainKeys.activeOwner(input.userId, input.catId, input.threadId), 'replacement-owner');
      assert.equal(await redis.hget(SessionChainKeys.detail(previous.id), 'status'), 'active');
      assert.equal(await store.isActiveOwnerSession(previous.id, 'native-previous'), false);
    });
  }
}
