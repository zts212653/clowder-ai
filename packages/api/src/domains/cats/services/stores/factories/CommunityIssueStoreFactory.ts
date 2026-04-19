/**
 * Community Issue Store Factory (F168)
 * Redis available → RedisCommunityIssueStore
 * No Redis → InMemoryCommunityIssueStore
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { InMemoryCommunityIssueStore } from '../memory/InMemoryCommunityIssueStore.js';
import type { ICommunityIssueStore } from '../ports/CommunityIssueStore.js';
import { RedisCommunityIssueStore } from '../redis/RedisCommunityIssueStore.js';

export function createCommunityIssueStore(redis?: RedisClient): ICommunityIssueStore {
  if (redis) {
    return new RedisCommunityIssueStore(redis);
  }
  return new InMemoryCommunityIssueStore();
}
