import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
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
      const source = await store.append({
        userId: 'user-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: 'completed reply',
        mentions: [],
        timestamp: index,
        extra: { coordination: { id: `coord-${index}`, phase: 'terminal', hop: 2, subjectRef: `work-${index}` } },
      });
      ids.push(source.id);
    }
    const first = await store.scanCoordinationTerminalMessageIds();
    assert.equal(first.messageIds.length, 100);
    assert.deepEqual(first.nextCursor, { offset: 100, upperBound: 101 });
    await store.append({
      userId: 'user-1',
      threadId: 'thread-1',
      catId: null,
      content: 'new work',
      mentions: [],
      timestamp: 999,
    });
    const restarted = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const second = await restarted.scanCoordinationTerminalMessageIds(first.nextCursor);
    assert.deepEqual([...first.messageIds, ...second.messageIds], ids);
    assert.equal(second.nextCursor, undefined);
  },
);

test(
  '#1371 dogfood: HTTP orphan recovery clears Redis custody and remains settled after rebuilding stores',
  options,
  async (t) => {
    const redis = await connect(t);
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store });
    const source = await store.append({
      userId: 'user-1',
      threadId: 'thread-1',
      catId: null,
      content: 'orphan dogfood fixture',
      mentions: ['opus', 'codex'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });
    const { entry } = queue.enqueue({
      userId: 'user-1',
      threadId: 'thread-1',
      content: source.content,
      messageId: source.id,
      targetCats: ['opus', 'codex'],
      source: 'user',
      ownerAuthProvenance: 'strict',
      intent: 'execute',
    });
    await store.initializeQueueCustody(source.id, createInitialQueuedMessageCustody(entry));
    queue.markProcessingById('thread-1', entry.id);
    await coordinator.persistEntry(queue.getEntrySnapshot('thread-1', 'user-1', entry.id));
    let providerCalls = 0;
    const records = {
      listRunningByThread: async () => [],
      update: async () => {},
      create: async () => {
        throw new Error('no invocation allowed');
      },
    };
    const socketManager = { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} };
    const processor = new QueueProcessor({
      queue,
      invocationTracker: tracker,
      queueCustodyCoordinator: coordinator,
      messageStore: store,
      invocationRecordStore: records,
      socketManager,
      log: { info() {}, warn() {}, error() {} },
      router: {
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
      queueCustodyCoordinator: coordinator,
      invocationRecordStore: records,
      socketManager,
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    t.after(() => app.close());
    const headers = { 'x-cat-cafe-user': 'user-1' };
    const before = await (await fetch(`${address}/api/threads/thread-1/queue`, { headers })).json();
    assert.equal(before.queue.length, 1);
    assert.equal(before.queue[0].recoveryActions[0].kind, 'force_reset');
    const reset = await fetch(`${address}/api/threads/thread-1/force-reset`, { method: 'POST', headers });
    assert.equal(reset.status, 200);
    const after = await (await fetch(`${address}/api/threads/thread-1/queue`, { headers })).json();
    assert.deepEqual(after.queue, []);
    const restarted = new RedisMessageStore(redis, { ttlSeconds: 0 });
    assert.equal((await restarted.getById(source.id)).deliveryStatus, 'canceled');
    assert.deepEqual(await restarted.scanByDeliveryStatus('queued'), []);
    assert.equal(providerCalls, 0);
    t.diagnostic(
      `Dogfood HTTP ${address}: Queue 1 -> 0; reset 200; Redis rebuilt store canceled; provider calls ${providerCalls}`,
    );
  },
);
