/**
 * F246 Phase B: Dispatch Proposal Store Factory.
 * REDIS_URL set → RedisDispatchProposalStore (persistent)
 * otherwise → InMemoryDispatchProposalStore (tests / dev)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IDispatchProposalStore } from '../ports/IDispatchProposalStore.js';
import { InMemoryDispatchProposalStore } from '../ports/IDispatchProposalStore.js';
import { RedisDispatchProposalStore } from '../redis/RedisDispatchProposalStore.js';

export function createDispatchProposalStore(redis?: RedisClient): IDispatchProposalStore {
  if (redis) return new RedisDispatchProposalStore(redis);
  return new InMemoryDispatchProposalStore();
}
