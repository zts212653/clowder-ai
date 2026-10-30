import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

it(
  'the active-execution HTTP reader preserves live identity and owner isolation after index reuse',
  {
    skip: redisIsolationSkipReason(REDIS_URL),
  },
  async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'running index consumer');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisInvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { createActiveExecutionService } = await import(
      '../dist/domains/cats/services/agents/invocation/active-execution-service.js'
    );
    const { queueRoutes } = await import('../dist/routes/queue.js');
    const keyPrefix = `invocation-consumer-${randomUUID()}:`;
    const writerClient = createRedisClient({ url: REDIS_URL, keyPrefix });
    const readerClient = createRedisClient({ url: REDIS_URL, keyPrefix });
    const apps = [];
    try {
      await writerClient.ping();
      const writer = new RedisInvocationRecordStore(writerClient);
      const threadStore = new ThreadStore();
      const thread = threadStore.create('owner', 'Running work', '/index-consumer');
      const { invocationId } = await writer.create({
        threadId: thread.id,
        userId: 'owner',
        targetCats: ['opus'],
        intent: 'execute',
        idempotencyKey: randomUUID(),
        actionLeaseCarrier: { kind: 'none' },
      });
      await writer.update(invocationId, { status: 'running' });
      await writerClient.del(`invoc:running:${thread.id}:owner`, 'invoc:running-threads:owner');
      const invocationTracker = new InvocationTracker();
      invocationTracker.start(thread.id, 'opus', 'owner', ['opus'], invocationId);
      assert.equal(
        invocationTracker.bindLifecycleActiveRun(
          {
            threadId: thread.id,
            targetId: 'opus',
            invocationId: `child-${invocationId}`,
            responseMessageId: `response-${invocationId}`,
            inputEntryIds: [],
            inputMessageIds: [],
            privateInputEntryIds: [],
            startedAt: Date.now(),
          },
          invocationId,
        ),
        true,
      );

      async function readerApp(recordStore) {
        const dynamicTaskStore = { getAll: () => [], getById: () => null };
        const service = createActiveExecutionService({
          invocationTracker,
          recordStore,
          dynamicTaskStore,
          log: { info() {}, warn() {} },
        });
        const app = Fastify();
        apps.push(app);
        await app.register(queueRoutes, {
          threadStore,
          invocationQueue: new InvocationQueue(),
          invocationTracker,
          invocationRecordStore: recordStore,
          activeExecutionService: service,
          dynamicTaskStore,
          queueProcessor: {
            canReleaseSlotForUser: () => true,
            processNext: async () => ({ started: false }),
            isPaused: () => false,
            getPauseReason: () => undefined,
            clearPause() {},
            releaseSlot() {},
            releaseThread() {},
          },
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          agentSessionMutex: { forceReleaseByScope: () => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] }) },
          getManagedCommandWakeRecovery: () => undefined,
        });
        await app.ready();
        return app;
      }
      async function read(app, user = 'owner') {
        const response = await app.inject({
          method: 'GET',
          url: '/api/executions/active?scope=all',
          headers: { 'x-cat-cafe-user': user },
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
      }
      const first = await readerApp(writer);
      const cold = await read(first);
      assert.equal(cold.executions.length, 1);
      assert.equal(cold.executions[0].threadId, thread.id);
      assert.equal(cold.executions[0].turnInvocationId, `child-${invocationId}`);
      await first.close();

      let scans = 0;
      const scan = readerClient.scan.bind(readerClient);
      readerClient.scan = (...args) => {
        scans += 1;
        return scan(...args);
      };
      const next = await readerApp(new RedisInvocationRecordStore(readerClient));
      const warm = await read(next);
      assert.deepEqual(warm, cold, 'the same live child and exact control target remain visible');
      assert.deepEqual((await read(next, 'foreign')).executions, [], 'index reuse grants no thread visibility');
      assert.equal(scans, 0, 'the actual HTTP composition must reuse the complete index');
    } finally {
      for (const app of apps) await app.close();
      await cleanupClientKeyspace(writerClient);
      await Promise.all([writerClient.quit(), readerClient.quit()]);
    }
  },
);
