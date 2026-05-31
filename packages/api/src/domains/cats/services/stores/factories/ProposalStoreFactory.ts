/**
 * F128 Proposal Store Factory
 * REDIS_URL set → RedisProposalStore
 * otherwise → InMemoryProposalStore
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IProposalStore } from '../ports/ProposalStore.js';
import { InMemoryProposalStore } from '../ports/ProposalStore.js';
import { RedisProposalStore } from '../redis/RedisProposalStore.js';

export function createProposalStore(redis?: RedisClient): IProposalStore {
  if (redis) return new RedisProposalStore(redis);
  return new InMemoryProposalStore();
}
