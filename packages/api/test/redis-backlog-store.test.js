/**
 * RedisBacklogStore tests
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisBacklogStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisBacklogStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;
  let originalDateNow;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisBacklogStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisBacklogStore.js');
    RedisBacklogStore = storeModule.RedisBacklogStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-backlog-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisBacklogStore(redis, { ttlSeconds: 120 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['backlog:item:*', 'backlog:items:user:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['backlog:item:*', 'backlog:items:user:*']);
    originalDateNow = Date.now;
  });

  afterEach(() => {
    if (originalDateNow) {
      Date.now = originalDateNow;
    }
  });

  async function createDispatchedItem(title) {
    const created = await store.create({
      userId: 'default-user',
      title,
      summary: `${title} summary`,
      priority: 'p1',
      tags: ['lease'],
      createdBy: 'user',
    });

    await store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'ready',
      plan: 'dispatch + lease',
      requestedPhase: 'coding',
    });
    await store.decideClaim(created.id, {
      decision: 'approve',
      decidedBy: 'default-user',
    });
    await store.markDispatched(created.id, {
      threadId: `thread-${created.id}`,
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });
    return created.id;
  }

  it('concurrent acquire by different cats: only one succeeds', async () => {
    const itemId = await createDispatchedItem('acquire-race');

    const results = await Promise.allSettled([
      store.acquireLease(itemId, {
        catId: 'codex',
        ttlMs: 60_000,
        actorId: 'default-user',
      }),
      store.acquireLease(itemId, {
        catId: 'opus',
        ttlMs: 60_000,
        actorId: 'default-user',
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const latest = await store.get(itemId);
    assert.ok(latest?.lease);
    assert.equal(latest?.lease?.state, 'active');
    assert.ok(['codex', 'opus'].includes(latest?.lease?.ownerCatId ?? ''));
  });

  it('concurrent heartbeat vs reclaim at expiry boundary: exactly one transition wins', async () => {
    const itemId = await createDispatchedItem('heartbeat-reclaim-race');
    await store.acquireLease(itemId, {
      catId: 'codex',
      ttlMs: 2_000,
      actorId: 'default-user',
    });

    const seeded = await store.get(itemId);
    assert.ok(seeded?.lease);
    if (!seeded?.lease) return;

    const beforeExpiry = seeded.lease.expiresAt - 1;
    const afterExpiry = seeded.lease.expiresAt + 1;
    const timestamps = [beforeExpiry, afterExpiry];
    Date.now = () => timestamps.shift() ?? afterExpiry;

    const results = await Promise.allSettled([
      store.heartbeatLease(itemId, {
        catId: 'codex',
        ttlMs: 5_000,
        actorId: 'default-user',
      }),
      store.reclaimExpiredLease(itemId, {
        actorId: 'default-user',
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const latest = await store.get(itemId);
    assert.ok(latest?.lease);
    if (!latest?.lease) return;

    assert.ok(latest.lease.state === 'active' || latest.lease.state === 'reclaimed');
    const heartbeatCount = latest.audit.filter((entry) => entry.action === 'lease_heartbeat').length;
    const reclaimCount = latest.audit.filter((entry) => entry.action === 'lease_reclaimed').length;
    assert.equal(heartbeatCount + reclaimCount, 1);
  });
});
