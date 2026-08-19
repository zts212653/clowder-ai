import type { RedisClient } from '@cat-cafe/shared/utils';
import { InMemoryTurnExecutionStore } from '../memory/InMemoryTurnExecutionStore.js';
import { RedisTurnExecutionStore } from '../redis/RedisTurnExecutionStore.js';

export type AnyTurnExecutionStore = InMemoryTurnExecutionStore | RedisTurnExecutionStore;

export function createTurnExecutionStore(redis?: RedisClient): AnyTurnExecutionStore {
  return redis ? new RedisTurnExecutionStore(redis) : new InMemoryTurnExecutionStore();
}
