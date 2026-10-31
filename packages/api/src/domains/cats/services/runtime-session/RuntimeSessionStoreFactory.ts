/**
 * RuntimeSessionStore Factory
 * F211 Phase A1: Redis available -> RedisRuntimeSessionStore, otherwise in-memory.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { RedisRuntimeSessionStore } from './RedisRuntimeSessionStore.js';
import { RuntimeSessionStore } from './RuntimeSessionStore.js';

export type AnyRuntimeSessionStore = RuntimeSessionStore | RedisRuntimeSessionStore;

export function createRuntimeSessionStore(redis?: RedisClient): AnyRuntimeSessionStore {
  if (redis) {
    return new RedisRuntimeSessionStore(redis);
  }
  return new RuntimeSessionStore();
}
