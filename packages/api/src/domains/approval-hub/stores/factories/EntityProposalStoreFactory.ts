/**
 * F260 Phase A: Entity Proposal Store Factory.
 * REDIS_URL set → RedisEntityProposalStore (persistent, Iron Law #5)
 * otherwise → InMemoryEntityProposalStore (tests / dev)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IEntityProposalStore } from '../ports/IEntityProposalStore.js';
import { InMemoryEntityProposalStore } from '../ports/IEntityProposalStore.js';
import { RedisEntityProposalStore } from '../redis/RedisEntityProposalStore.js';

export function createEntityProposalStore(redis?: RedisClient): IEntityProposalStore {
  if (redis) return new RedisEntityProposalStore(redis);
  return new InMemoryEntityProposalStore();
}
