import { randomUUID } from 'node:crypto';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { RedisQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { failedResponseFixture } from './1398-failed-response-fixture.mjs';
import { assertRedisIsolationOrThrow, cleanupClientKeyspace } from './redis-test-helpers.js';

export async function crossThreadFailureStores(t, kind) {
  let redis;
  if (kind === 'redis') {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'cross-thread failure return');
    redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `test-cross-failure:${randomUUID()}:` });
    t.after(async () => {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    });
  }
  const messages = redis ? new RedisMessageStore(redis, { ttlSeconds: 0 }) : new MessageStore();
  const ledger = redis ? new RedisQueueLedgerStore(redis) : new InMemoryQueueLedgerStore();
  const drains = [];
  const queue = new InvocationQueue(ledger, { onAdmitted: ({ threadId }) => drains.push(threadId) });
  return { messages, ledger, queue, drains };
}

export async function crossThreadResponseFixture(t, kind, { sameCat = false } = {}) {
  const stores = await crossThreadFailureStores(t, kind);
  return failedResponseFixture(
    { ...stores, turns: new InMemoryTurnExecutionStore() },
    {
      callerCatId: sameCat ? 'opus' : 'codex',
      crossPost: { sourceThreadId: 'origin', sourceInvocationId: 'origin-parent' },
    },
  );
}
