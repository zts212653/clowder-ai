// F317 north-star regression harness: guarded access to the REAL RedisMessageStore.
// Only the repo's isolated runner (scripts/run-isolated-redis-tests.sh: temp instance, random port, never
// 6397/6398/6399/6401) may satisfy the guard; anywhere else the caller skips. Every key lives under a per-test prefix.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RedisMessageStore } from '../../src/domains/cats/services/stores/redis/RedisMessageStore.js';

const PROTECTED = new Set(['6397', '6398', '6399', '6401']);

export function isolatedRedisUrl(): string | null {
  const raw = process.env.REDIS_URL;
  if (process.env.CAT_CAFE_REDIS_TEST_ISOLATED !== '1' || !raw) return null;
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || PROTECTED.has(url.port)) return null;
  return raw;
}

export const REDIS_SKIP =
  isolatedRedisUrl() === null ? 'needs the isolated Redis runner (never 6397/6398/6399/6401)' : false;

export async function withRedisStore<T>(
  fn: (store: RedisMessageStore, redis: Redis, prefix: string) => Promise<T>,
): Promise<T> {
  const url = isolatedRedisUrl();
  if (url === null) throw new Error('isolated Redis required');
  const prefix = `f317-ns-reg-${randomUUID()}:`;
  const redis = new Redis(url, { keyPrefix: prefix, maxRetriesPerRequest: 1 });
  try {
    return await fn(new RedisMessageStore(redis), redis, prefix);
  } finally {
    await redis.quit();
  }
}
