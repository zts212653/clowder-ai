/**
 * Thread Store Factory
 * REDIS_URL 有值 → RedisThreadStore
 * 无 → ThreadStore (内存)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { IThreadStore } from '../ports/ThreadStore.js';
import { ThreadStore } from '../ports/ThreadStore.js';
import { RedisThreadStore } from '../redis/RedisThreadStore.js';

const log = createModuleLogger('thread-store-factory');

function resolveThreadTtlSeconds(): number | undefined {
  const raw = process.env.THREAD_TTL_SECONDS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    log.warn({ raw }, 'Invalid THREAD_TTL_SECONDS, using default');
    return undefined;
  }
  return Math.trunc(parsed);
}

export function createThreadStore(redis?: RedisClient): IThreadStore {
  if (redis) {
    const ttlSeconds = resolveThreadTtlSeconds();
    return new RedisThreadStore(redis, ttlSeconds !== undefined ? { ttlSeconds } : undefined);
  }
  return new ThreadStore();
}
