import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { queueRoutes } = await import('../dist/routes/queue.js');

async function until(predicate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail('Queue did not reach the expected settlement boundary');
}

async function settlingQueue(t) {
  const threadId = 'settlement-thread';
  const userId = 'settlement-user';
  const catId = 'opus';
  const queue = new InvocationQueue();
  const invocationTracker = new InvocationTracker();
  const invocationRecordStore = new InvocationRecordStore();
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  const messageStore = new MessageStore();
  const draftStore = new DraftStore();
  const log = { info: mock.fn(), warn: mock.fn(), error: mock.fn() };
  const socketManager = {
    broadcastAgentMessage: mock.fn(),
    broadcastToRoom: mock.fn(),
    emitToUser: mock.fn(),
  };
  let parentId;
  let ackStarted = false;
  let resumeAck;
  const ackBarrier = new Promise((resolve) => {
    resumeAck = resolve;
  });
  const router = {
    resolveExplicitTargets: async (cats) => [...cats],
    resolveConversationTargetsAtAdmission: async (cats) => [...cats],
    async *routeExecution(_userId, _content, _threadId, _intent, _cats, _images, options) {
      parentId = options.parentInvocationId;
      const child = {
        invocationId: 'settlement-child',
        parentInvocationId: parentId,
        threadId,
        userId,
        catId,
        startedAt: Date.now(),
      };
      await turnExecutionStore.createRunning({ ...child, executionKind: 'ordinary' });
      await options.onLifecycleInvocationStarted(child);
      yield { type: 'text', catId, content: 'The review is durably delivered.', timestamp: Date.now() };
      await turnExecutionStore.transitionTerminal(child.invocationId, { status: 'succeeded', endedAt: Date.now() });
      yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
      invocationTracker.complete(threadId, catId);
    },
    async ackCollectedCursors() {
      ackStarted = true;
      await ackBarrier;
    },
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker,
    invocationRecordStore,
    turnExecutionStore,
    messageStore,
    draftStore,
    router,
    socketManager,
    log,
  });
  const thread = { id: threadId, title: 'Settlement', projectPath: '/project/settlement', createdBy: userId };
  const sessionLocks = { forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })) };
  const app = Fastify();
  await app.register(queueRoutes, {
    threadStore: { get: async () => thread, list: async () => [thread], listByProject: async () => [thread] },
    invocationQueue: queue,
    invocationTracker,
    invocationRecordStore,
    turnExecutionStore,
    messageStore,
    draftStore,
    queueProcessor: processor,
    socketManager,
    agentSessionMutex: sessionLocks,
    cliExecutionOwnerService: { listLive: async () => ({ owners: [], complete: true }) },
  });
  await app.ready();
  t.after(async () => {
    resumeAck();
    await until(() => !processor.hasProcessingSlotReservation(threadId, catId));
    await app.close();
  });
  const input = canonicalTestQueueInput({
    threadId,
    userId,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    sourceId: 'settlement-input',
    content: 'Please review.',
    targetCats: [catId],
    intent: 'execute',
  });
  await queue.send(
    messageStore,
    canonicalTestMessageInput({
      threadId,
      userId,
      catId: null,
      content: input.content,
      mentions: [catId],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    }),
    input,
  );
  assert.equal((await processor.processNext(threadId, userId)).started, true);
  await until(() => ackStarted || log.error.mock.callCount() > 0);
  assert.equal(
    ackStarted,
    true,
    log.error.mock.calls
      .map((call) => call.arguments.map((value) => value?.err?.stack ?? String(value)).join(' '))
      .join('\n'),
  );
  assert.equal(invocationTracker.has(threadId, catId), false, 'provider ownership has ended');
  assert.equal((await turnExecutionStore.get('settlement-child')).status, 'succeeded');
  assert.equal(processor.hasProcessingSlotReservation(threadId, catId), true, 'producer still owns settlement');
  // Advance only wall-clock observation, without waiting a minute or changing durable records.
  const observedAt = Date.now() + 60_000;
  t.mock.method(Date, 'now', () => observedAt);
  return {
    app,
    processor,
    invocationRecordStore,
    turnExecutionStore,
    log,
    socketManager,
    sessionLocks,
    threadId,
    userId,
    catId,
    parentId,
    resumeAck,
  };
}

async function assertSuccessfulSettlement(harness) {
  harness.resumeAck();
  await until(() => !harness.processor.hasProcessingSlotReservation(harness.threadId, harness.catId));
  assert.equal((await harness.invocationRecordStore.get(harness.parentId)).status, 'succeeded');
  assert.equal(harness.log.error.mock.callCount(), 0, 'ordinary completion must not reject a terminal update');
}

describe('active execution read-repair during Queue settlement', () => {
  for (const scope of ['thread', 'project']) {
    it(`${scope} polling preserves a completed child while its real Queue producer still settles`, async (t) => {
      const h = await settlingQueue(t);
      const response = await h.app.inject({
        method: 'GET',
        url:
          scope === 'thread'
            ? `/api/threads/${h.threadId}/executions/active`
            : '/api/executions/active?projectPath=%2Fproject%2Fsettlement',
        headers: { 'x-cat-cafe-user': h.userId },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(
        (await h.invocationRecordStore.get(h.parentId)).status,
        'running',
        'a living producer must retain the right to commit its successful parent terminal',
      );
      assert.equal(h.sessionLocks.forceReleaseByScope.mock.callCount(), 0);
      assert.equal(
        h.socketManager.broadcastAgentMessage.mock.calls.some((call) => call.arguments[0]?.type === 'canceled'),
        false,
      );
      await assertSuccessfulSettlement(h);
    });
  }

  it('repairs a different orphan for the same cat without releasing the settling producer', async (t) => {
    const h = await settlingQueue(t);
    const { invocationId: orphanId } = await h.invocationRecordStore.create({
      threadId: h.threadId,
      userId: h.userId,
      targetCats: [h.catId],
      intent: 'execute',
      idempotencyKey: 'older-orphan',
      actionLeaseCarrier: { kind: 'none' },
    });
    await h.invocationRecordStore.update(orphanId, { status: 'running' });
    const later = Date.now() + 60_000;
    t.mock.method(Date, 'now', () => later);
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/threads/${h.threadId}/executions/active`,
      headers: { 'x-cat-cafe-user': h.userId },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await h.invocationRecordStore.get(orphanId)).error, 'execution_owner_lost');
    assert.equal(
      h.processor.hasProcessingSlotReservation(h.threadId, h.catId),
      true,
      'repairing an orphan must not steal a different producer reservation',
    );
    assert.equal((await h.invocationRecordStore.get(h.parentId)).status, 'running');
    assert.equal(
      h.sessionLocks.forceReleaseByScope.mock.callCount(),
      0,
      'the replacement producer retains its session locks',
    );
    await assertSuccessfulSettlement(h);
  });
});
