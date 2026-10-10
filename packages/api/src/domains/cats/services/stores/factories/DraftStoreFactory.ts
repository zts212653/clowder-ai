/**
 * Draft Store Factory
 * Redis → RedisDraftStore, 无 → DraftStore (内存)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IDraftStore } from '../ports/DraftStore.js';
import { DraftStore } from '../ports/DraftStore.js';
import { RedisDraftStore } from '../redis/RedisDraftStore.js';

export function createDraftStore(redis?: RedisClient): IDraftStore {
  return redis ? new RedisDraftStore(redis) : new DraftStore();
}
