import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisTaskProgressStore owner-aware cleanup', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisTaskProgressStore owner-aware cleanup');
    const { RedisTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisTaskProgressStore.js'
    );
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisTaskProgressStore(redis, 0);
  });

  after(async () => {
    if (!redis || !connected) return;
    await cleanupPrefixedRedisKeys(redis, ['task-progress:owner-test-*']);
    await redis.quit();
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['task-progress:owner-test-*']);
  });

  it('uses an atomic compare-and-delete so zombie A cannot delete replacement B', async () => {
    const replacement = {
      threadId: 'owner-test-thread',
      catId: 'codex',
      tasks: [],
      status: 'running',
      updatedAt: Date.now(),
      lastInvocationId: 'replacement-B',
    };
    await store.setSnapshot(replacement);

    assert.equal(await store.deleteSnapshotIfOwner(replacement.threadId, replacement.catId, 'zombie-A'), false);
    assert.deepEqual(await store.getSnapshot(replacement.threadId, replacement.catId), replacement);

    assert.equal(
      await store.deleteSnapshotIfOwner(replacement.threadId, replacement.catId, replacement.lastInvocationId),
      true,
    );
    assert.equal(await store.getSnapshot(replacement.threadId, replacement.catId), null);
  });
});
