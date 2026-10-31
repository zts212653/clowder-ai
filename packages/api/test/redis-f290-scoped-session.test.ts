import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { verifyScopedSessionStore, verifyScopedWithoutHome } from './helpers/f290-scoped-session-contract.js';

test('Redis scoped session records persist without changing home active identity or gaining resume authority', async () => {
  const { assertRedisIsolationOrThrow } = await import('./helpers/redis-test-helpers.js');
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'f290-scoped-session-store');
  const { createRedisClient } = await import('@cat-cafe/shared/utils');
  const { RedisSessionChainStore } = await import(
    '../src/domains/cats/services/stores/redis/RedisSessionChainStore.js'
  );
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f290-scoped:${randomUUID()}:` });
  try {
    await verifyScopedSessionStore(new RedisSessionChainStore(redis));
    await verifyScopedWithoutHome(new RedisSessionChainStore(redis));
  } finally {
    const { cleanupPrefixedRedisKeys } = await import('./helpers/redis-test-helpers.js');
    await cleanupPrefixedRedisKeys(redis, ['session:*', 'session-*']);
    await redis.quit();
  }
});
