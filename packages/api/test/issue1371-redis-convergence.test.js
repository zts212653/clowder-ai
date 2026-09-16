import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SessionStore } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { assembleIncrementalContext } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { cursorHarness, deferred } from './helpers/issue1371-cursor-harness.js';
import { runDirectWitnessScenario } from './helpers/issue1371-direct-witness-harness.js';
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
  '#1371 Redis: adopted terminal receipt repairs after a new child re-reads the durable wake',
  options,
  async (t) => {
    const { RedisBallCustodyEventLog } = await import('../dist/domains/ball-custody/BallCustodyEventLog.js');
    const { RedisBallCustodyProjectionStore } = await import(
      '../dist/domains/ball-custody/BallCustodyProjectionStore.js'
    );
    const { BallCustodyProjector } = await import('../dist/domains/ball-custody/BallCustodyProjector.js');
    const { BallCustodyIngest } = await import('../dist/domains/ball-custody/BallCustodyIngest.js');
    const { buildHeldEvent, buildHandedEvent, buildWakeConditionMetEvent } = await import(
      '../dist/domains/ball-custody/ball-custody-events.js'
    );
    const { ManagedHoldDispositionService } = await import(
      '../dist/domains/ball-custody/ManagedHoldDispositionService.js'
    );
    const { ManagedHoldReceiptService } = await import('../dist/domains/ball-custody/ManagedHoldReceiptService.js');
    const { turnCustodyAdoptionRegistry } = await import('../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js');
    const redis = await connect(t);
    const messageStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const eventLog = new RedisBallCustodyEventLog(redis);
    const projectionStore = new RedisBallCustodyProjectionStore(redis);
    const projector = new BallCustodyProjector(eventLog, projectionStore);
    const ingest = new BallCustodyIngest(eventLog, projector);
    const queue = new InvocationQueue();
    const threadId = 'thread-adopted-restart';
    const userId = 'user-1';
    const catId = 'codex';
    const taskId = 'task-adopted-restart';
    const entry = queue.enqueue({
      threadId,
      userId,
      ownerAuthProvenance: 'unknown',
      content: '[定时任务] gate passed',
      source: 'connector',
      sourceCategory: 'scheduled',
      targetCats: [catId],
      intent: 'execute',
    }).entry;
    const userSource = await messageStore.append({
      threadId,
      userId,
      catId: null,
      content: 'Finish this work',
      mentions: [],
      timestamp: Date.now(),
    });
    const source = await messageStore.append({
      threadId,
      userId: 'scheduler',
      catId: null,
      content: entry.content,
      mentions: [catId],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        icon: 'timer',
        meta: { threadId, catId, taskId, wakeWhen: true },
      },
      queueCustody: createInitialQueuedMessageCustody(entry),
    });
    queue.backfillMessageId(threadId, userId, entry.id, source.id);
    queue.markProcessing(threadId, userId);
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore });
    queue.markProcessingSeen(threadId, userId, entry.id, [catId], 'before-crash', Date.now());
    await coordinator.persistEntry(queue.getEntrySnapshot(threadId, userId, entry.id));
    await ingest.record(buildHeldEvent({ threadId, catId, fireAt: Date.now(), at: Date.now() }));
    await ingest.record(
      buildWakeConditionMetEvent({
        threadId,
        catId,
        taskId,
        command: 'pnpm test',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        at: Date.now(),
      }),
    );
    await ingest.record(buildHandedEvent({ threadId, toCatId: catId, messageId: source.id, at: Date.now() }));
    const wake = {
      kind: 'structured',
      protocol: 'hold',
      subjectKey: `ball:thread:${threadId}`,
      holderCatId: catId,
      sourceMessageId: source.id,
      taskId,
    };
    const auth = { invocationId: 'before-crash', userId, threadId, catId, originTriggerMessageId: userSource.id };
    let currentChild = auth.invocationId;
    const registry = { isLatest: async (invocationId) => invocationId === currentChild };
    const before = new ManagedHoldDispositionService({
      registry,
      dynamicTaskStore: { getById: () => null },
      messageStore,
      ballCustodyEventLog: eventLog,
      ballCustodyProjectionStore: projectionStore,
      ballCustody: ingest,
      receiptService: {
        async complete() {
          throw new Error('crash after terminal append');
        },
      },
    });
    const unregister = turnCustodyAdoptionRegistry.register(auth.invocationId, async () => {});
    await turnCustodyAdoptionRegistry.adopt(auth.invocationId, [wake]);
    await assert.rejects(before.complete(auth, 'completed'), /crash after terminal append/);
    await unregister();
    const rebuilt = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const recoveredQueue = new InvocationQueue();
    recoveredQueue.restoreDurableEntry(queue.getEntrySnapshot(threadId, userId, entry.id));
    const recoveredCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: rebuilt });
    currentChild = 'after-restart';
    const nextAuth = { ...auth, invocationId: currentChild };
    const after = new ManagedHoldDispositionService({
      registry,
      dynamicTaskStore: { getById: () => null },
      messageStore: rebuilt,
      ballCustodyEventLog: new RedisBallCustodyEventLog(redis),
      ballCustodyProjectionStore: new RedisBallCustodyProjectionStore(redis),
      ballCustody: ingest,
      receiptService: new ManagedHoldReceiptService({
        queue: recoveredQueue,
        messageStore: rebuilt,
        coordinator: recoveredCoordinator,
      }),
    });
    await assert.rejects(after.complete(auth, 'completed'), /stale_invocation/);
    t.after(turnCustodyAdoptionRegistry.register(currentChild, async () => {}));
    await turnCustodyAdoptionRegistry.adopt(currentChild, [wake]);
    await assert.rejects(after.complete(nextAuth, 'completed'), /adopted_source_mismatch/);
    recoveredQueue.markProcessingSeen(threadId, userId, entry.id, [catId], currentChild, Date.now());
    await recoveredCoordinator.persistEntry(recoveredQueue.getEntrySnapshot(threadId, userId, entry.id));
    const result = await after.complete(nextAuth, 'completed');
    assert.equal(result.outcome, 'replayed');
    assert.equal(result.sourceMessageId, source.id);
    assert.equal(
      (await eventLog.read(wake.subjectKey)).filter((event) => event.kind === 'ball.hold_dispositioned').length,
      1,
    );
    assert.equal(recoveredQueue.list(threadId, userId).length, 0);
    assert.deepEqual((await new RedisMessageStore(redis).getById(source.id)).queueCustody.handledByCatIds, [catId]);
    assert.equal((await projectionStore.get(wake.subjectKey)).state, 'resolved');
  },
);

test(
  '#1371 Redis: target append-to-ack crash repairs cold cursors before its failed sibling finishes',
  options,
  async (t) => {
    const redis = await connect(t);
    const blocked = deferred();
    const firstDone = deferred();
    let providerCalls = 0;
    const {
      deps,
      source,
      boundaries,
      options: routeOptions,
    } = await cursorHarness(
      {
        opus: {
          supportsToolExecutionPolicy: () => true,
          async *invoke() {
            providerCalls++;
            yield { type: 'text', catId: 'opus', content: 'persisted exact target answer', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
        codex: {
          supportsToolExecutionPolicy: () => true,
          async *invoke() {
            providerCalls++;
            await blocked.promise;
            yield { type: 'error', catId: 'codex', error: 'sibling provider quota', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          },
        },
      },
      new RedisMessageStore(redis, { ttlSeconds: 0 }),
    );
    deps.deliveryCursorStore.ackCursor = async () => {
      throw new Error('crash window: cursor not committed');
    };
    const execution = (async () => {
      for await (const event of routeParallel(
        deps,
        ['opus', 'codex'],
        source.content,
        'user-1',
        'thread-cursor',
        routeOptions,
      )) {
        if (event.type === 'done' && event.catId === 'opus') firstDone.resolve(event.messageId);
      }
    })();
    try {
      const replyId = await Promise.race([
        firstDone.promise,
        execution.then(() => {
          throw new Error('no completed target');
        }),
      ]);
      const reply = await deps.messageStore.getById(replyId);
      assert.equal(
        reply.extra.deliveryBoundary.cursor,
        boundaries.get('opus'),
        'Redis parser retains the append proof',
      );
      await Promise.all([
        deps.messageStore.updateExtra(replyId, {
          deliveryBoundary: { ...reply.extra.deliveryBoundary, cursor: 'forged' },
        }),
        deps.messageStore.augmentStreamMetadata(replyId, {
          extra: { stream: { invocationId: 'child-1', turnInvocationId: 'child-1' } },
        }),
      ]);
      const rebuilt = new RedisMessageStore(redis, { ttlSeconds: 0 });
      assert.deepEqual((await rebuilt.getById(replyId)).extra.deliveryBoundary, reply.extra.deliveryBoundary);
      const cursors = () =>
        new DeliveryCursorStore(new SessionStore(redis), (id, threadId) => rebuilt.canonicalizeCursor(id, threadId));
      const [workerA, workerB] = [cursors(), cursors()];
      const contexts = await Promise.all(
        [workerA, workerB].map((deliveryCursorStore) =>
          assembleIncrementalContext(
            {
              messageStore: rebuilt,
              deliveryCursorStore,
              invocationDeps: {},
            },
            'user-1',
            'thread-cursor',
            'opus',
          ),
        ),
      );
      assert.equal(await cursors().getCursor('user-1', 'opus', 'thread-cursor'), boundaries.get('opus'));
      assert.equal(await cursors().getCursor('user-1', 'codex', 'thread-cursor'), undefined);
      for (const context of contexts) {
        assert.ok(!context.navigationHeader.includes('independently answer'));
        assert.ok(!context.contextText.includes('independently answer'));
      }
      assert.equal(providerCalls, 2, 'recovery reads do not re-invoke either provider');
    } finally {
      blocked.resolve();
      await execution;
    }
  },
);

test(
  '#1371 Redis/HTTP: direct completion consumes adopted scheduler wakes before automatic review',
  options,
  async (t) => {
    const redis = await connect(t);
    const messageStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const result = await runDirectWitnessScenario(t, { messageStore, useHttp: true });
    const restarted = new RedisMessageStore(redis, { ttlSeconds: 0 });
    for (const sourceId of result.sourceMessageIds) {
      const source = await restarted.getById(sourceId);
      assert.equal(source.queueCustody.status, 'terminal');
      assert.equal(source.queueCustody.targetOutcomeByCatId.codex.consumption.sourceMessageId, sourceId);
    }
    assert.deepEqual(await restarted.scanByDeliveryStatus('queued'), []);
    assert.deepEqual(result.calls, [['codex'], ['opus']]);
    t.diagnostic(
      'HTTP user message -> two scheduler receipts consumed -> automatic review once -> Queue 0; new Redis store stays settled',
    );
  },
);

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
