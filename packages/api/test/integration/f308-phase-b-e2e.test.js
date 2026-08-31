import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const SKIP = redisIsolationSkipReason(REDIS_URL);
const KEY_PREFIX = 'cat-cafe-f308-phase-b-e2e:';
let redis;

before(async () => {
  if (SKIP) return;
  assertRedisIsolationOrThrow(REDIS_URL, 'f308-phase-b-e2e');
  const { createRedisClient } = await import('@cat-cafe/shared/utils');
  redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
  await cleanupClientKeyspace(redis);
});

after(async () => {
  if (!redis) return;
  await cleanupClientKeyspace(redis);
  await redis.quit();
});

describe('F308 Phase B global recent acceptance', { skip: SKIP }, () => {
  test('owner current discovery and persistent recent index feed one canonical collection route', async () => {
    const [
      { ThreadStore },
      { MessageStore },
      { TaskStore },
      { RedisThreadProgressReceiptStore },
      { ThreadBriefAssembler },
      { ThreadBriefCurrentDiscovery },
      { ThreadBriefCollectionAssembler },
      { threadProgressRoutes },
    ] = await Promise.all([
      import('../../dist/domains/cats/services/stores/ports/ThreadStore.js'),
      import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../../dist/domains/cats/services/stores/ports/TaskStore.js'),
      import('../../dist/domains/thread-progress/RedisThreadProgressReceiptStore.js'),
      import('../../dist/domains/thread-progress/ThreadBriefAssembler.js'),
      import('../../dist/domains/thread-progress/ThreadBriefCurrentDiscovery.js'),
      import('../../dist/domains/thread-progress/ThreadBriefCollectionAssembler.js'),
      import('../../dist/routes/thread-progress-routes.js'),
    ]);
    const ownerUserId = 'f308-phase-b-owner';
    const threadStore = new ThreadStore();
    const messageStore = new MessageStore();
    const taskStore = new TaskStore();
    const receiptStore = new RedisThreadProgressReceiptStore(redis);
    const currentThread = threadStore.create(ownerUserId, 'Runtime Harness 深入学习');
    const recentThread = threadStore.create(ownerUserId, 'Codex 开源范围调研');
    await receiptStore.appendIfAbsent(receipt(currentThread.id, ownerUserId, 200));
    await receiptStore.appendIfAbsent(receipt(recentThread.id, ownerUserId, 100));

    let liveReads = 0;
    const readLiveExecutions = async (threadId) => {
      liveReads++;
      return threadId === currentThread.id
        ? [{ catId: 'cat-vjdun65e', startedAt: 150, turnInvocationId: 'turn-current', degraded: false }]
        : [];
    };
    const briefAssembler = new ThreadBriefAssembler({
      receiptStore,
      taskStore,
      readLiveExecutions,
      readAttention: async () => [],
      readWaits: async () => [],
    });
    const discovery = new ThreadBriefCurrentDiscovery({
      listRunningThreadIds: async () => [currentThread.id],
      listAttention: async () => [],
      listWaits: async () => [],
      readLiveExecutions,
    });
    const collectionAssembler = new ThreadBriefCollectionAssembler({
      threadStore,
      receiptStore,
      briefAssembler,
      discoverCurrentFacts: (userId) => discovery.discover(userId),
    });
    const app = Fastify();
    await app.register(threadProgressRoutes, {
      threadStore,
      receiptStore,
      assembler: briefAssembler,
      collectionAssembler,
      messageStore,
      taskStore,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/threads/briefs?scope=recent&limit=1',
        headers: { 'x-cat-cafe-user': ownerUserId },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        response.json().current.map((brief) => brief.thread.id),
        [currentThread.id],
      );
      assert.deepEqual(
        response.json().recent.map((brief) => brief.thread.id),
        [recentThread.id],
      );
      assert.equal(liveReads, 1, 'recent-only thread must not trigger a liveness read');
      assert.equal(response.json().nextCursor, null);
    } finally {
      await app.close();
    }
  });
});

function receipt(threadId, ownerUserId, occurredAt) {
  return {
    v: 1,
    id: `receipt-${threadId}`,
    ownerUserId,
    threadId,
    kind: 'milestone',
    impactAxes: ['verified_outcome'],
    actor: { kind: 'cat', catId: 'cat-vjdun65e' },
    headline: `进展 ${threadId}`,
    nextStep: '继续验证',
    provenance: [{ kind: 'invocation', invocationId: `inv-${threadId}` }],
    sourceKey: `source-${threadId}`,
    occurredAt,
    createdAt: occurredAt,
  };
}
