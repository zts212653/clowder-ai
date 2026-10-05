import type { Redis } from 'ioredis';
import { RedisContextEpochStore } from '../../src/domains/cats/services/stores/redis/RedisContextEpochStore.js';
import { RedisMessageStore } from '../../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisProposalStore } from '../../src/domains/cats/services/stores/redis/RedisProposalStore.js';
import { RedisSummaryStore } from '../../src/domains/cats/services/stores/redis/RedisSummaryStore.js';
import { RedisTaskStore } from '../../src/domains/cats/services/stores/redis/RedisTaskStore.js';
import { MessageLiveInboxSource } from '../../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';
import { fixtureApprovalRegistry, scope } from './f317-recovery-fixture.js';

export function redisRecoverySources(redis: Redis) {
  const messages = new RedisMessageStore(redis);
  const proposals = new RedisProposalStore(redis);
  const authorize = async (candidate: typeof scope) =>
    candidate.userId === scope.userId && candidate.threadId === scope.threadId;
  return {
    messages,
    proposals,
    authorize,
    tasks: new RedisTaskStore(redis),
    summaries: new RedisSummaryStore(redis),
    epochs: new RedisContextEpochStore(redis),
    approvals: fixtureApprovalRegistry(proposals),
    inbox: new MessageLiveInboxSource({ store: messages, authorize }),
  };
}

export function isolatedRecoveryRedisUrl() {
  const url = process.env.F317_INBOX_TEST_REDIS_URL;
  if (!url) throw new Error('Redis fixture URL required');
  const address = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(address.hostname) || address.port !== '6398' || address.pathname !== '/15')
    throw new Error('Only isolated Redis6398/15 allowed');
  return url;
}
