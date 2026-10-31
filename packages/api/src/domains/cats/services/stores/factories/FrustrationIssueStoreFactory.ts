/**
 * F222: Factory for FrustrationIssueStore.
 *
 * Redis → RedisFrustrationIssueStore (persistent, Iron Law #5);
 * No Redis → InMemory fallback (dev/test only).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { InMemoryFrustrationIssueStore } from '../memory/InMemoryFrustrationIssueStore.js';
import type { IFrustrationIssueStore } from '../ports/FrustrationIssueStore.js';
import { RedisFrustrationIssueStore } from '../redis/RedisFrustrationIssueStore.js';

export function createFrustrationIssueStore(redis?: RedisClient): IFrustrationIssueStore {
  if (redis) return new RedisFrustrationIssueStore(redis);
  return new InMemoryFrustrationIssueStore();
}
