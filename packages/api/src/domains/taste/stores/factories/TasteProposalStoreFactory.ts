/**
 * F221 Phase B: Taste Proposal Store Factory.
 * REDIS_URL set → RedisTasteProposalStore (persistent, Iron Law #5)
 * otherwise → InMemoryTasteProposalStore (tests / dev)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { InMemoryTasteProposalStore } from '../InMemoryTasteProposalStore.js';
import type { ITasteProposalStore } from '../ports/TasteProposalStore.js';
import { RedisTasteProposalStore } from '../redis/RedisTasteProposalStore.js';

export function createTasteProposalStore(redis?: RedisClient): ITasteProposalStore {
  if (redis) return new RedisTasteProposalStore(redis);
  return new InMemoryTasteProposalStore();
}
