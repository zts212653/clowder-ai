import type { RedisClient } from '@cat-cafe/shared/utils';
import type { EventMemoryCorrectionProposalStore } from './EventMemoryCorrectionProposalStore.js';
import { InMemoryEventMemoryCorrectionProposalStore } from './InMemoryEventMemoryCorrectionProposalStore.js';
import { RedisEventMemoryCorrectionProposalStore } from './RedisEventMemoryCorrectionProposalStore.js';

export function createEventMemoryCorrectionProposalStore(redis?: RedisClient): EventMemoryCorrectionProposalStore {
  return redis ? new RedisEventMemoryCorrectionProposalStore(redis) : new InMemoryEventMemoryCorrectionProposalStore();
}
