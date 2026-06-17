/**
 * F231 Phase C Profile-Update Proposal Store Factory
 * REDIS_URL set → RedisProfileUpdateProposalStore
 * otherwise → InMemoryProfileUpdateProposalStore
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IProfileUpdateProposalStore } from '../ports/ProfileUpdateProposalStore.js';
import { InMemoryProfileUpdateProposalStore } from '../ports/ProfileUpdateProposalStore.js';
import { RedisProfileUpdateProposalStore } from '../redis/RedisProfileUpdateProposalStore.js';

export function createProfileUpdateProposalStore(redis?: RedisClient): IProfileUpdateProposalStore {
  if (redis) return new RedisProfileUpdateProposalStore(redis);
  return new InMemoryProfileUpdateProposalStore();
}
