/**
 * Draft Store Factory
 * Redis → RedisDraftStore, 无 → DraftStore (内存)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { IDraftStore } from '../ports/DraftStore.js';
import { DraftStore } from '../ports/DraftStore.js';
import { RedisDraftStore } from '../redis/RedisDraftStore.js';

const log = createModuleLogger('draft-store-factory');

function resolveDraftTtlSeconds(): number | undefined {
  const raw = process.env.DRAFT_TTL_SECONDS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    log.warn({ raw }, 'Invalid DRAFT_TTL_SECONDS, using default');
    return undefined;
  }
  return Math.trunc(parsed);
}

export function createDraftStore(redis?: RedisClient): IDraftStore {
  if (redis) {
    const ttlSeconds = resolveDraftTtlSeconds();
    return new RedisDraftStore(redis, ttlSeconds !== undefined ? { ttlSeconds } : undefined);
  }
  return new DraftStore();
}
