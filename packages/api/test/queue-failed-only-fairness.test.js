import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { QueuedMessageCustodyCoordinator, createInitialQueuedMessageCustody } = await import(
  '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
);
const { StartupReconciler } = await import('../dist/domains/cats/services/agents/invocation/StartupReconciler.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

function enqueue(queue, overrides = {}) {
  return queue.enqueue({
    threadId: 'thread-fairness',
    userId: 'user-owner',
    content: 'queued work',
    source: 'user',
    ownerAuthProvenance: 'strict',
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  }).entry;
}

function markFailed(queue, entry, catId) {
  queue.markQueuedFailedForCatAcrossUsers(entry.threadId, catId, `failed-invocation-${catId}`, new Set([entry.id]));
}
function createProcessorHarness({
  queue = new InvocationQueue(),
  messageStore = new MessageStore(),
  busyCatIds = new Set(),
  persistCustody = false,
} = {}) {
  const startedCats = [];
  let invocationSequence = 0;
  const socketManager = {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser() {},
  };
  const deps = {
    queue,
    messageStore,
    socketManager,
    invocationTracker: {
      has(_threadId, catId) {
        return busyCatIds.has(catId);
      },
      startAll(_threadId, catIds) {
        startedCats.push(...catIds);
        return new AbortController();
      },
      waitForSessionSealRelease() {
        return Promise.resolve();
      },
      completeAll() {},
    },
    invocationRecordStore: {
      create() {
        invocationSequence += 1;
        return { outcome: 'created', invocationId: `inv-fairness-${invocationSequence}` };
      },
      update(id, data) {
        return { id, ...data };
      },
    },
    router: {
      async *routeExecution(_userId, _content, _threadId, _messageId, targetCats) {
        for (const catId of targetCats) yield { type: 'done', catId, timestamp: Date.now() };
      },
      async ackCollectedCursors() {},
    },
    log: { info() {}, warn() {}, error() {} },
  };
  if (persistCustody) {
    deps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
  }
  return { deps, processor: new QueueProcessor(deps), queue, messageStore, socketManager, startedCats };
}
const flushDispatch = () => new Promise((resolve) => setTimeout(resolve, 25));

async function enqueueFreshA2A(harness, { crossThread }) {
  const triggerMessage = harness.messageStore.append({
    userId: 'user-a2a',
    catId: 'opus',
    content: crossThread ? 'cross-thread fresh A2A' : 'same-thread fresh A2A',
    mentions: ['codex'],
    timestamp: 200,
    threadId: 'thread-fairness',
    ...(crossThread ? { deliveryStatus: 'queued' } : {}),
    ...(crossThread
      ? {
          extra: {
            crossPost: {
              sourceThreadId: 'thread-source',
              sourceInvocationId: 'inv-source',
              effectClass: 'coordinate',
            },
          },
        }
      : {}),
  });
  return enqueueA2ATargets(
    {
      router: harness.deps.router,
      invocationRecordStore: harness.deps.invocationRecordStore,
      socketManager: harness.socketManager,
      invocationTracker: harness.deps.invocationTracker,
      messageStore: harness.messageStore,
      queueProcessor: harness.processor,
      invocationQueue: harness.queue,
      log: harness.deps.log,
    },
    {
      targetCats: ['codex'],
      content: triggerMessage.content,
      userId: 'user-a2a',
      ownerAuthProvenance: 'strict',
      threadId: triggerMessage.threadId,
      triggerMessage,
      callerCatId: 'opus',
      parentInvocationId: 'inv-source',
    },
  );
}

describe('#1371 failed-only non-agent fairness gate', () => {
  for (const crossThread of [false, true]) {
    it(`${crossThread ? 'cross-thread' : 'same-thread'} enqueueA2ATargets skips a failed-only connector and starts fresh A2A`, async () => {
      const harness = createProcessorHarness({ persistCustody: crossThread });
      const failedConnector = enqueue(harness.queue, {
        userId: 'user-connector',
        content: 'old scheduled connector',
        source: 'connector',
        sourceCategory: 'scheduled',
        autoExecute: false,
        targetCats: ['opus'],
      });
      markFailed(harness.queue, failedConnector, 'opus');
      const result = await enqueueFreshA2A(harness, { crossThread });
      await flushDispatch();
      assert.deepEqual(result.enqueued, ['codex']);
      assert.deepEqual(harness.startedCats, ['codex'], 'fresh A2A must start without replaying the failed target');
      const retained = harness.queue.getEntrySnapshot('thread-fairness', 'user-connector', failedConnector.id);
      assert.equal(retained.status, 'queued');
      assert.deepEqual(retained.queuedFailedByCatIds, ['opus']);
    });
  }

  it('restart-restored failed-only connector does not poison a later same-thread A2A', async () => {
    const messageStore = new MessageStore();
    const beforeRestartQueue = new InvocationQueue();
    const failedConnector = enqueue(beforeRestartQueue, {
      userId: 'user-connector',
      content: 'durable scheduled connector',
      source: 'connector',
      sourceCategory: 'scheduled',
      autoExecute: false,
      targetCats: ['opus'],
    });
    const connectorMessage = messageStore.append({
      userId: failedConnector.userId,
      catId: null,
      content: failedConnector.content,
      mentions: failedConnector.targetCats,
      timestamp: failedConnector.createdAt,
      threadId: failedConnector.threadId,
      deliveryStatus: 'queued',
      source: 'connector',
      queueCustody: createInitialQueuedMessageCustody(failedConnector),
    });
    beforeRestartQueue.backfillMessageId(
      failedConnector.threadId,
      failedConnector.userId,
      failedConnector.id,
      connectorMessage.id,
    );
    markFailed(beforeRestartQueue, failedConnector, 'opus');
    const custodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
    await custodyCoordinator.persistEntry(
      beforeRestartQueue.getEntrySnapshot(failedConnector.threadId, failedConnector.userId, failedConnector.id),
    );
    messageStore.scanByDeliveryStatus = (status) => (status === 'queued' ? [connectorMessage.id] : []);

    const restartedQueue = new InvocationQueue();
    const startup = new StartupReconciler({
      invocationRecordStore: {
        async scanByStatus() {
          return [];
        },
        async get() {
          return null;
        },
        async update() {},
      },
      invocationQueue: restartedQueue,
      messageStore,
      taskProgressStore: { async deleteSnapshot() {} },
      log: { info() {}, warn() {} },
    });
    const recovery = await startup.reconcileOrphans();
    assert.equal(recovery.queueEntriesRestored, 1);
    const restored = restartedQueue.getEntrySnapshot(
      failedConnector.threadId,
      failedConnector.userId,
      failedConnector.id,
    );
    assert.deepEqual(restored.queuedFailedByCatIds, ['opus']);
    const harness = createProcessorHarness({ queue: restartedQueue, messageStore });
    await enqueueFreshA2A(harness, { crossThread: false });
    await flushDispatch();
    assert.deepEqual(harness.startedCats, ['codex']);
    assert.deepEqual(
      restartedQueue.getEntrySnapshot(failedConnector.threadId, failedConnector.userId, failedConnector.id)
        .queuedFailedByCatIds,
      ['opus'],
    );
  });

  it('mixed connector still wins fairness through its ordinary-eligible sibling', async () => {
    const harness = createProcessorHarness();
    const mixedConnector = enqueue(harness.queue, {
      userId: 'user-connector',
      source: 'connector',
      targetCats: ['opus', 'gemini'],
    });
    markFailed(harness.queue, mixedConnector, 'opus');
    enqueue(harness.queue, {
      userId: 'user-a2a',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      autoExecute: true,
    });
    await harness.processor.tryAutoExecute('thread-fairness');
    await flushDispatch();
    assert.equal(harness.startedCats[0], 'gemini', 'eligible non-agent sibling must retain fairness priority');
    assert.equal(harness.startedCats.includes('opus'), false, 'failed sibling must never be replayed');
  });

  it('mixed connector starts only its unpaused sibling before later A2A advances', async () => {
    const harness = createProcessorHarness();
    const { promise: routeBarrier, resolve: releaseRoute } = Promise.withResolvers();
    harness.deps.router.routeExecution = async function* (_userId, _content, _threadId, _messageId, targetCats) {
      await routeBarrier;
      for (const catId of targetCats) yield { type: 'done', catId, timestamp: Date.now() };
    };
    enqueue(harness.queue, {
      userId: 'user-connector',
      source: 'connector',
      targetCats: ['opus', 'gemini'],
    });
    await harness.processor.onInvocationComplete(
      'thread-fairness',
      'opus',
      'failed',
      undefined,
      [],
      false,
      {},
      [],
      {},
      true,
    );
    assert.equal(harness.processor.isPaused('thread-fairness', 'opus'), true);
    enqueue(harness.queue, {
      userId: 'user-a2a',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      autoExecute: true,
    });
    await harness.processor.tryAutoExecute('thread-fairness');
    assert.deepEqual(harness.startedCats, ['gemini']);
    releaseRoute();
    await flushDispatch();
    assert.deepEqual(harness.startedCats, ['gemini', 'codex']);
  });

  it('busy ordinary-eligible connector still holds the fairness gate', async () => {
    const harness = createProcessorHarness({ busyCatIds: new Set(['gemini']) });
    enqueue(harness.queue, {
      userId: 'user-connector',
      source: 'connector',
      targetCats: ['gemini'],
    });
    const a2a = enqueue(harness.queue, {
      userId: 'user-a2a',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      autoExecute: true,
    });

    await harness.processor.tryAutoExecute('thread-fairness');
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(harness.startedCats, []);
    assert.equal(harness.queue.getEntrySnapshot(a2a.threadId, a2a.userId, a2a.id).status, 'queued');
  });

  it('failed-only row in one user scope cannot block concurrent A2A in other user scopes', async () => {
    const harness = createProcessorHarness();
    const failedConnector = enqueue(harness.queue, {
      userId: 'user-connector',
      source: 'connector',
      targetCats: ['opus'],
    });
    markFailed(harness.queue, failedConnector, 'opus');
    enqueue(harness.queue, {
      userId: 'user-a2a-1',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      autoExecute: true,
    });
    enqueue(harness.queue, {
      userId: 'user-a2a-2',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex-terra'],
      autoExecute: true,
    });

    await harness.processor.tryAutoExecute('thread-fairness');
    await flushDispatch();

    assert.deepEqual(new Set(harness.startedCats), new Set(['codex', 'codex-terra']));
  });

  it('failed target remains closed to ordinary scheduling until exact Retry reopens it', () => {
    const queue = new InvocationQueue();
    const failedConnector = enqueue(queue, {
      userId: 'user-connector',
      source: 'connector',
      targetCats: ['opus'],
    });
    markFailed(queue, failedConnector, 'opus');

    assert.equal(queue.markProcessingAcrossUsers('thread-fairness'), null);
    const retry = queue.retryFailedTarget('thread-fairness', 'user-connector', failedConnector.id, 'opus');
    assert.ok(retry, 'exact Retry must be the only operation that reopens the failed target');
    const processing = queue.markProcessingAcrossUsers('thread-fairness');
    assert.equal(processing.id, failedConnector.id);
    assert.deepEqual(processing.queuedFailedByCatIds, undefined);
  });
});
