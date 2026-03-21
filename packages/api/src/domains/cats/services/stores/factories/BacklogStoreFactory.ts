import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { IBacklogStore } from '../ports/BacklogStore.js';
import { BacklogStore } from '../ports/BacklogStore.js';
import { RedisBacklogStore } from '../redis/RedisBacklogStore.js';

const log = createModuleLogger('backlog-store-factory');

function resolveBacklogTtlSeconds(): number | undefined {
  const raw = process.env.BACKLOG_TTL_SECONDS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    log.warn({ raw }, 'Invalid BACKLOG_TTL_SECONDS, using default');
    return undefined;
  }
  return Math.trunc(parsed);
}

export function createBacklogStore(redis?: RedisClient): IBacklogStore {
  if (redis) {
    const ttlSeconds = resolveBacklogTtlSeconds();
    return new RedisBacklogStore(redis, ttlSeconds !== undefined ? { ttlSeconds } : undefined);
  }
  return new BacklogStore();
}
