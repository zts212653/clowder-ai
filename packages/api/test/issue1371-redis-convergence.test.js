import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;
const options = { skip: redisIsolationSkipReason(redisUrl) };
async function connect(t) {
  assertRedisIsolationOrThrow(redisUrl, 'issue1371-convergence');
  const redis = new Redis(redisUrl, { keyPrefix: `issue1371:${randomUUID()}:`, maxRetriesPerRequest: 1 });
  await redis.ping();
  t.after(async () => {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  return redis;
}

test(
  '#1371 Redis: terminal recovery has bounded stable pages and survives a new store instance',
  options,
  async (t) => {
    const redis = await connect(t);
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const ids = [];
    for (let index = 0; index < 101; index++) {
      const source = await store.append(
        canonicalTestMessageInput({
          userId: 'user-1',
          threadId: 'thread-1',
          catId: 'opus',
          content: 'completed reply',
          mentions: [],
          timestamp: index,
          extra: { coordination: { id: `coord-${index}`, phase: 'terminal', hop: 2, subjectRef: `work-${index}` } },
        }),
      );
      ids.push(source.id);
    }
    const first = await store.scanCoordinationTerminalMessageIds();
    assert.equal(first.messageIds.length, 100);
    assert.deepEqual(first.nextCursor, { offset: 100, upperBound: 101 });
    await store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        threadId: 'thread-1',
        catId: null,
        content: 'new work',
        mentions: [],
        timestamp: 999,
      }),
    );
    const restarted = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const second = await restarted.scanCoordinationTerminalMessageIds(first.nextCursor);
    assert.deepEqual([...first.messageIds, ...second.messageIds], ids);
    assert.equal(second.nextCursor, undefined);
  },
);

test(
  '#1371 dogfood: HTTP pre-start recovery clears Queue and remains canceled after rebuilding Redis stores',
  options,
  async (t) => {
    const redis = await connect(t);
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const queue = new InvocationQueue(new RedisQueueLedgerStore(redis));
    const tracker = new InvocationTracker();
    const queueInput = canonicalTestQueueInput({
      threadId: 'thread-1',
      userId: 'user-1',
      kind: 'conversation_input',
      sourceId: 'issue1371-redis-prestart-source',
      content: 'orphan dogfood fixture',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
    });
    const admitted = await queue.appendAndEnqueueDurable(
      store,
      canonicalTestMessageInput({
        threadId: queueInput.threadId,
        userId: queueInput.userId,
        from: queueInput.from,
        catId: null,
        content: queueInput.content,
        mentions: queueInput.targetCats,
        timestamp: Date.now(),
        deliveryStatus: 'queued',
      }),
      queueInput,
    );
    const source = admitted.message;
    let releaseCreate;
    const createGate = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    let createCalls = 0;
    let providerCalls = 0;
    const records = {
      listRunningByThread: async () => [],
      update: async () => {},
      create: async () => {
        createCalls++;
        await createGate;
        return { outcome: 'created', invocationId: 'inv-redis-prestart' };
      },
    };
    const socketManager = { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} };
    const processor = new QueueProcessor({
      queue,
      invocationTracker: tracker,
      messageStore: store,
      invocationRecordStore: records,
      socketManager,
      log: { info() {}, warn() {}, error() {} },
      router: {
        resolveConversationTargetsAtAdmission: async (targets) => [...targets],
        resolveExplicitTargets: async (targets) => [...targets],
        routeExecution: async function* () {
          providerCalls++;
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
        ackCollectedCursors: async () => {},
      },
    });
    const app = Fastify();
    await app.register(queueRoutes, {
      threadStore: { get: async () => ({ createdBy: 'user-1' }) },
      invocationQueue: queue,
      invocationTracker: tracker,
      queueProcessor: processor,
      messageStore: store,
      invocationRecordStore: records,
      socketManager,
    });
    t.after(() => app.close());
    const headers = { 'x-cat-cafe-user': 'user-1' };
    await processor.processNext('thread-1', 'user-1');
    while (createCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const beforeResponse = await app.inject({ method: 'GET', url: '/api/threads/thread-1/queue', headers });
    const before = beforeResponse.json();
    assert.equal(before.queue.length, 1);
    const reset = await app.inject({ method: 'POST', url: '/api/threads/thread-1/force-reset', headers });
    releaseCreate();
    assert.equal(reset.statusCode, 200, reset.body);
    const afterResponse = await app.inject({ method: 'GET', url: '/api/threads/thread-1/queue', headers });
    const after = afterResponse.json();
    assert.deepEqual(after.queue, []);
    const restarted = new RedisMessageStore(redis, { ttlSeconds: 0 });
    assert.equal((await restarted.getById(source.id)).deliveryStatus, 'canceled');
    assert.deepEqual(await restarted.scanByDeliveryStatus('queued'), []);
    assert.equal(providerCalls, 0);
    t.diagnostic('Dogfood HTTP inject: Queue 1 -> 0; reset 200; Redis rebuilt store canceled; provider calls 0');
  },
);
