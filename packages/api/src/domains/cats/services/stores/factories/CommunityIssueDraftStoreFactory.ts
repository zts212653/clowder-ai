/**
 * F235: Factory for CommunityIssueDraftStore.
 *
 * Redis → RedisCommunityIssueDraftStore (persistent, Iron Law #5);
 * No Redis → InMemory fallback (dev/test only).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { InMemoryCommunityIssueDraftStore } from '../memory/InMemoryCommunityIssueDraftStore.js';
import type { ICommunityIssueDraftStore } from '../ports/CommunityIssueDraftStore.js';
import { RedisCommunityIssueDraftStore } from '../redis/RedisCommunityIssueDraftStore.js';

export function createCommunityIssueDraftStore(redis?: RedisClient): ICommunityIssueDraftStore {
  if (redis) return new RedisCommunityIssueDraftStore(redis);
  return new InMemoryCommunityIssueDraftStore();
}
