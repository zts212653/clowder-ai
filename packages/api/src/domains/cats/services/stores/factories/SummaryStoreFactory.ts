/**
 * Summary Store Factory
 * Redis → RedisSummaryStore, 无 → SummaryStore (内存)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { ISummaryStore } from '../ports/SummaryStore.js';
import { SummaryStore } from '../ports/SummaryStore.js';
import { RedisSummaryStore } from '../redis/RedisSummaryStore.js';

const log = createModuleLogger('summary-store-factory');

function resolveSummaryTtlSeconds(): number | undefined {
  const raw = process.env.SUMMARY_TTL_SECONDS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    log.warn({ raw }, 'Invalid SUMMARY_TTL_SECONDS, using default');
    return undefined;
  }
  return Math.trunc(parsed);
}

export function createSummaryStore(redis?: RedisClient): ISummaryStore {
  if (redis) {
    const ttlSeconds = resolveSummaryTtlSeconds();
    return new RedisSummaryStore(redis, ttlSeconds !== undefined ? { ttlSeconds } : undefined);
  }
  return new SummaryStore();
}
