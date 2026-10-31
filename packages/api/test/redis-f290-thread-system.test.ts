import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { verifyCollectiveThreadSystem } from './helpers/f290-collective-thread-contract.js';

test('Redis preserves collective system classification and refuses foreign, deleted and conflicting claims', async () => {
  const { assertRedisIsolationOrThrow, cleanupPrefixedRedisKeys } = await import('./helpers/redis-test-helpers.js');
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'f290-collective-thread-system');
  const { createRedisClient } = await import('@cat-cafe/shared/utils');
  const { RedisThreadStore } = await import('../src/domains/cats/services/stores/redis/RedisThreadStore.js');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f290-system:${randomUUID()}:` });
  try {
    await verifyCollectiveThreadSystem(new RedisThreadStore(redis));
  } finally {
    await cleanupPrefixedRedisKeys(redis, ['thread:*', 'threads:*']);
    await redis.quit();
  }
});
