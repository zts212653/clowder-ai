// @ts-check

import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { resolveManagedCommandWakeEventCarrier } from '../dist/domains/ball-custody/managed-command-wake-lifecycle.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { ConnectorInvokeTrigger } from '../dist/infrastructure/email/ConnectorInvokeTrigger.js';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

// ─── Shared Mocks ───────────────────────────────────────────────

function noopLog() {
  const noop = () => {};
  return /** @type {any} */ ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  });
}

/**
 * Mock router that yields a single done message.
 * Tracks calls for assertion. Can be configured to fail.
 */
function mockRouter(opts = {}) {
  const calls = /** @type {any[]} */ ([]);
  const ackCalls = /** @type {any[]} */ ([]);

  return {
    calls,
    ackCalls,
    /** @type {any} */
    router: {
      async resolveExplicitTargets(requestedCatIds) {
        return [...requestedCatIds];
      },
      async resolveConversationTargetsAtAdmission(requestedCatIds) {
        return requestedCatIds.length > 0 ? [...requestedCatIds] : ['opus'];
      },
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, _options) {
        calls.push({ userId, message, threadId, userMessageId, targetCats, intent });

        if (/** @type {any} */ (opts).throwError) throw /** @type {any} */ (opts).throwError;

        yield { type: 'text', catId: targetCats[0], content: `Processed: ${message}`, timestamp: Date.now() };
        yield {
          type: 'done',
          catId: targetCats[0],
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
        };
      },
      async ackCollectedCursors(userId, threadId) {
        ackCalls.push({ userId, threadId });
      },
    },
  };
}

function mockSocketManager() {
  const broadcasts = /** @type {any[]} */ ([]);
  const roomBroadcasts = /** @type {any[]} */ ([]);
  const userEmits = /** @type {any[]} */ ([]);
  return {
    broadcasts,
    roomBroadcasts,
    userEmits,
    /** @type {any} */
    manager: {
      broadcastAgentMessage(msg, threadId) {
        broadcasts.push({ msg, threadId });
      },
      broadcastToRoom(room, event, data) {
        roomBroadcasts.push({ room, event, data });
      },
      emitToUser(userId, event, data) {
        userEmits.push({ userId, event, data });
      },
    },
  };
}

function mockInvocationRecordStore() {
  let counter = 0;
  const creates = /** @type {any[]} */ ([]);
  const updates = /** @type {any[]} */ ([]);
  const records = new Map();
  return {
    creates,
    updates,
    records,
    /** @type {any} */
    store: {
      async create(input) {
        creates.push(input);
        counter++;
        const invocationId = `inv-${counter}`;
        records.set(invocationId, {
          id: invocationId,
          ...input,
          userMessageId: null,
          status: 'queued',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        return { outcome: 'created', invocationId };
      },
      async update(id, data) {
        updates.push({ id, data });
        const record = records.get(id);
        if (!record) return null;
        if (data.expectedStatus !== undefined && record.status !== data.expectedStatus) return null;
        const { expectedStatus: _expectedStatus, ...patch } = data;
        const updated = { ...record, ...patch, updatedAt: Date.now() };
        records.set(id, updated);
        return updated;
      },
      async get(id) {
        const record = records.get(id);
        return record === undefined ? null : record;
      },
      async getByIdempotencyKey() {
        return null;
      },
      async listRunningByThread(threadId, userId) {
        return [...records.values()].filter(
          (record) => record.threadId === threadId && record.userId === userId && record.status === 'running',
        );
      },
    },
  };
}

/**
 * InvocationTracker mock with active thread tracking.
 * - start() marks thread as active
 * - complete() clears active and calls onComplete callback
 */
function mockInvocationTracker() {
  const activeThreads = new Set();
  const starts = /** @type {any[]} */ ([]);
  const completes = /** @type {any[]} */ ([]);
  /** @type {((threadId: string, status: string) => void) | null} */
  let _onCompleteCallback = null;

  return {
    starts,
    completes,
    activeThreads,
    setActive(threadId) {
      activeThreads.add(threadId);
    },
    clearActive(threadId) {
      activeThreads.delete(threadId);
    },
    /** Register callback for when complete is called (simulates wiring) */
    onComplete(cb) {
      _onCompleteCallback = cb;
    },
    /** @type {any} */
    tracker: {
      start(threadId, catId, userId, catIds) {
        starts.push({ threadId, catId, userId, catIds });
        activeThreads.add(threadId);
        return new AbortController();
      },
      startAll(threadId, catIds, userId) {
        starts.push({ threadId, catId: catIds[0], userId, catIds });
        activeThreads.add(threadId);
        return new AbortController();
      },
      complete(threadId, _catId, _controller) {
        completes.push({ threadId });
        activeThreads.delete(threadId);
      },
      completeAll(threadId, _catIds, _controller) {
        completes.push({ threadId });
        activeThreads.delete(threadId);
      },
      has(threadId) {
        return activeThreads.has(threadId);
      },
      tryStartThread(threadId, catId, userId, catIds) {
        if (activeThreads.has(threadId)) return null;
        starts.push({ threadId, catId, userId, catIds });
        activeThreads.add(threadId);
        return new AbortController();
      },
    },
  };
}

/** Wait for background execution */
async function settle(ms = 100) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Integration Tests ──────────────────────────────────────────

describe('Queue Integration (E2E scenarios)', () => {
  /** @type {InvocationQueue} */
  let queue;
  /** @type {QueueProcessor} */
  let processor;
  /** @type {ReturnType<typeof mockRouter>} */
  let routerMock;
  /** @type {ReturnType<typeof mockSocketManager>} */
  let socketMock;
  /** @type {ReturnType<typeof mockInvocationRecordStore>} */
  let recordMock;
  /** @type {ReturnType<typeof mockInvocationTracker>} */
  let trackerMock;

  beforeEach(() => {
    queue = new InvocationQueue();
    routerMock = mockRouter();
    socketMock = mockSocketManager();
    recordMock = mockInvocationRecordStore();
    trackerMock = mockInvocationTracker();

    processor = new QueueProcessor({
      queue,
      invocationTracker: trackerMock.tracker,
      invocationRecordStore: recordMock.store,
      router: routerMock.router,
      socketManager: socketMock.manager,
      messageStore: { getById: async () => null },
      log: noopLog(),
    });
  });

  it('E2E: user sends while cat running → queued → invocation completes → auto-dequeue', async () => {
    // 1. Simulate a cat already running
    trackerMock.setActive('thread-1');

    // 2. Enqueue a user message (simulating what POST /api/messages does)
    const result = await queue.enqueueDurable(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'conversation_input',
        sourceId: 'integration-fix-bug',
        content: 'Fix the bug',
        source: 'user',
        targetCats: ['opus'],
        intent: 'execute',
      }),
    );
    assert.strictEqual(result.outcome, 'enqueued');

    // 3. Previous invocation completes (succeeded → auto-dequeue)
    trackerMock.clearActive('thread-1');
    await processor.onInvocationComplete('thread-1', 'opus', 'succeeded');
    await settle();

    // 4. Verify queued message was auto-processed
    assert.strictEqual(routerMock.calls.length, 1, 'Should have auto-dequeued and executed');
    assert.strictEqual(routerMock.calls[0].message, 'Fix the bug');
    assert.strictEqual(routerMock.calls[0].userId, 'user-1');

    // Queue should be empty after processing
    assert.strictEqual(queue.list('thread-1', 'user-1').length, 0);
  });

  it('E2E: queued work waits behind a manual-seal CAS without running or terminalizing', async () => {
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const tracker = new InvocationTracker();
    const guard = tracker.guardSessionSeal('thread-1', 'opus');
    assert.equal(guard.acquired, true);
    const localProcessor = new QueueProcessor({
      queue,
      invocationTracker: tracker,
      invocationRecordStore: recordMock.store,
      router: routerMock.router,
      socketManager: socketMock.manager,
      messageStore: /** @type {any} */ ({ getById: async () => null }),
      log: noopLog(),
    });
    await queue.enqueueDurable(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'conversation_input',
        sourceId: 'integration-session-seal',
        content: 'Run only after the old session pointer is cleared',
        source: 'user',
        targetCats: ['opus'],
        intent: 'execute',
        autoExecute: true,
      }),
    );

    const start = await localProcessor.processNext('thread-1', 'user-1');
    assert.equal(start.started, true);
    await settle(25);
    assert.equal(routerMock.calls.length, 0, 'route execution must not start under the seal guard');
    assert.equal(
      [...recordMock.records.values()].some((record) => record.status === 'running'),
      false,
      'the queued InvocationRecord must not be marked running under the seal guard',
    );

    guard.release();
    await settle(150);
    assert.equal(routerMock.calls.length, 1, 'the same queued turn must retry after the seal CAS releases');
    assert.equal(queue.list('thread-1', 'user-1').length, 0);
  });

  it('E2E: terminal cancellation requests the next Queue drain', async () => {
    // 1. Enqueue a message
    trackerMock.setActive('thread-1');
    await queue.enqueueDurable(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'conversation_input',
        sourceId: 'integration-terminal-cancel',
        content: 'Continue working',
        source: 'user',
        targetCats: ['opus'],
        intent: 'execute',
      }),
    );

    // 2. Terminal cancellation requests a drain.
    trackerMock.clearActive('thread-1');
    await processor.onInvocationComplete('thread-1', 'opus', 'canceled');
    await settle();

    // 3. Verify the message was processed without a Continue transition.
    assert.strictEqual(routerMock.calls.length, 1);
    assert.strictEqual(routerMock.calls[0].message, 'Continue working');
    assert.equal(
      socketMock.userEmits.some((event) => event.event === 'queue_paused'),
      false,
    );
  });

  it('E2E: connector message arrives during active invocation → queued', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const messageStore = new MessageStore();
    const sourceMessage = messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        from: { kind: 'external', connectorId: 'email' },
        content: 'Review email content',
        mentions: ['opus'],
        origin: 'connector',
        timestamp: Date.now(),
        threadId: 'thread-1',
        deliveryStatus: 'queued',
      }),
    );
    const localProcessor = new QueueProcessor({
      queue,
      invocationTracker: trackerMock.tracker,
      invocationRecordStore: recordMock.store,
      router: routerMock.router,
      socketManager: socketMock.manager,
      messageStore,
      log: noopLog(),
    });

    // 1. Simulate active invocation
    trackerMock.setActive('thread-1');

    // 2. ConnectorInvokeTrigger fires
    const trigger = new ConnectorInvokeTrigger({
      router: routerMock.router,
      socketManager: socketMock.manager,
      invocationRecordStore: recordMock.store,
      invocationTracker: trackerMock.tracker,
      invocationQueue: queue,
      queueProcessor: localProcessor,
      messageStore,
      log: noopLog(),
    });

    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', sourceMessage.content, sourceMessage.id);
    await settle();

    // 3. Verify it was queued (NOT directly executed)
    assert.strictEqual(routerMock.calls.length, 0, 'Should NOT execute directly');
    assert.strictEqual(recordMock.creates.length, 0, 'Should NOT create InvocationRecord');

    const entries = queue.list('thread-1', 'user-1');
    assert.strictEqual(entries.length, 1);
    assert.deepEqual(entries[0].from, { kind: 'external', connectorId: 'email' });
    assert.strictEqual(entries[0].payload.content, 'Review email content');
    assert.strictEqual(entries[0].payload.messageId, sourceMessage.id);

    // 4. queue_updated emitted
    const queueUpdate = socketMock.userEmits.find((e) => e.event === 'queue_updated');
    assert.ok(queueUpdate, 'Should emit queue_updated');

    // 5. Active invocation completes → auto-dequeue
    trackerMock.clearActive('thread-1');
    await localProcessor.onInvocationComplete('thread-1', 'opus', 'succeeded');
    await settle();

    assert.strictEqual(routerMock.calls.length, 1, 'Should auto-dequeue after completion');
    assert.strictEqual(routerMock.calls[0].message, 'Review email content');
  });

  it('E2E: a managed-command wake waits behind the active turn and settles from its response terminal', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const messageStore = new MessageStore();
    const wakeMessage = messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        from: { kind: 'system', service: 'managed-command-wake' },
        content: '[定时任务] 持球唤醒（命令完成）：门禁已结束。',
        mentions: ['opus'],
        origin: 'connector',
        timestamp: Date.now(),
        threadId: 'thread-1',
        deliveryStatus: 'queued',
        idempotencyKey: 'hold-ball-completion:hold-ball-e2e',
        source: {
          connector: 'hold-ball',
          label: '持球通知',
          icon: '🏓',
          meta: {
            managedHold: true,
            phase: 'wake',
            taskId: 'hold-ball-e2e',
            threadId: 'thread-1',
            catId: 'opus',
            wakeWhen: true,
          },
        },
      }),
    );
    const routeCalls = [];
    let responseMessageId;
    const lifecycleRouter = {
      async resolveExplicitTargets(requestedCatIds) {
        return [...requestedCatIds];
      },
      async resolveConversationTargetsAtAdmission(requestedCatIds) {
        return [...requestedCatIds];
      },
      async *routeExecution(userId, message, threadId, _messageId, targetCats, _intent, options) {
        routeCalls.push({ userId, message, threadId, targetCats });
        const invocationId = 'managed-wake-invocation';
        const startedAt = Date.now();
        const admission = await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: targetCats[0],
          invocationId,
          parentInvocationId: options.parentInvocationId,
          startedAt,
        });
        responseMessageId = admission.responseMessageId;
        const terminal = await messageStore.commitLifecycleResponseTerminal(responseMessageId, {
          invocationId,
          status: 'completed',
          completedAt: startedAt + 1,
          content: '门禁失败，已读取结果并完成处置。',
          mentions: [],
          origin: 'stream',
        });
        assert.equal(terminal.kind, 'applied');
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: startedAt + 1 };
      },
      async ackCollectedCursors() {},
    };
    const localProcessor = new QueueProcessor({
      queue,
      invocationTracker: trackerMock.tracker,
      invocationRecordStore: recordMock.store,
      router: lifecycleRouter,
      socketManager: socketMock.manager,
      messageStore,
      log: noopLog(),
    });
    const trigger = new ConnectorInvokeTrigger({
      socketManager: socketMock.manager,
      invocationQueue: queue,
      queueProcessor: localProcessor,
      messageStore,
      log: noopLog(),
    });

    trackerMock.setActive('thread-1');
    assert.equal(
      await trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        wakeMessage.content,
        wakeMessage.id,
        undefined,
        { priority: 'urgent', sourceCategory: 'scheduled' },
      ),
      'enqueued',
    );

    assert.equal(routeCalls.length, 0, 'the wake must not join or preempt the active provider turn');
    assert.equal(queue.findEntryWithMessageId('thread-1', wakeMessage.id)?.status, 'queued');
    assert.equal((await messageStore.getById(wakeMessage.id)).deliveryStatus, 'queued');

    trackerMock.clearActive('thread-1');
    await localProcessor.onInvocationComplete('thread-1', 'opus', 'succeeded');
    await settle(200);

    assert.equal(routeCalls.length, 1, 'the wake must start as the next Queue-owned invocation');
    assert.equal(queue.findEntryWithMessageId('thread-1', wakeMessage.id), undefined);
    const settledWake = await messageStore.getById(wakeMessage.id);
    assert.equal(settledWake.deliveryStatus, 'delivered');
    assert.equal(settledWake.lifecycle.dispatchRefs.length, 1);
    const response = await messageStore.getById(responseMessageId);
    assert.deepEqual(
      resolveManagedCommandWakeEventCarrier(settledWake, response, false, {
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'opus',
      }),
      { state: 'handled', invocationId: 'managed-wake-invocation' },
      'the canonical response terminal must retire the hold without a manual disposition tool',
    );
  });

  it('E2E: connector admission honors an active cancel/reset suppression fence', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const messageStore = new MessageStore();
    const sourceMessage = messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        from: { kind: 'external', connectorId: 'email' },
        content: 'Do not restart after reset',
        mentions: ['opus'],
        origin: 'connector',
        timestamp: Date.now(),
        threadId: 'thread-1',
        deliveryStatus: 'queued',
      }),
    );
    const localProcessor = new QueueProcessor({
      queue,
      invocationTracker: trackerMock.tracker,
      invocationRecordStore: recordMock.store,
      router: routerMock.router,
      socketManager: socketMock.manager,
      messageStore,
      log: noopLog(),
    });
    localProcessor.suppressAutoResume('thread-1', 'opus', ['cancelled-invocation']);
    const trigger = new ConnectorInvokeTrigger({
      router: routerMock.router,
      socketManager: socketMock.manager,
      invocationRecordStore: recordMock.store,
      invocationTracker: trackerMock.tracker,
      invocationQueue: queue,
      queueProcessor: localProcessor,
      messageStore,
      log: noopLog(),
    });

    await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', sourceMessage.content, sourceMessage.id);
    await settle();

    assert.equal(routerMock.calls.length, 0, 'a late connector wake must not bypass the reset owner');
    assert.equal(queue.findEntryWithMessageId('thread-1', sourceMessage.id)?.status, 'queued');
    assert.equal(localProcessor.isAutoResumeSuppressed('thread-1', 'opus'), true);
  });

  // ── RFC #1356: no-lost-wakeup drain on completion ──

  it('bugfix: autoExecute entry orphaned when target cat busy at enqueue → recovered on completion', async () => {
    // Scenario: gpt52 is executing via messages.ts path (tracked by invocationTracker).
    // An entry for gpt52 is enqueued. requestDrain stops at it because
    // invocationTracker.has(thread, 'gpt52') = true.
    // Later, gpt52's messages.ts execution completes and calls onInvocationComplete.
    // The completion chain (tryExecuteNextAcrossUsers) should pick up the orphaned entry.
    //
    // This test verifies that even without our fix, the BASIC recovery works
    // (when the completing cat IS the same as the orphaned entry's target cat).

    // 1. gpt52 is actively executing via messages.ts (NOT via QueueProcessor)
    trackerMock.setActive('thread-1');

    // 2. autoExecute entry for gpt52 is enqueued
    const enqResult = await queue.enqueueDurable(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'agent-user',
        kind: 'private_input',
        sourceId: 'integration-orphan-review',
        content: 'P1 修完，请 review',
        source: 'agent',
        targetCats: ['gpt52'],
        intent: 'execute',
        autoExecute: true,
      }),
    );
    assert.strictEqual(enqResult.outcome, 'enqueued');

    // 3. The enqueue signal requests the per-thread drain.
    await processor.requestDrain('thread-1');

    // 4. Entry should still be queued (not picked up because gpt52 slot busy)
    const entries = queue.list('thread-1', 'agent-user');
    assert.strictEqual(entries.length, 1, 'Entry should still be in queue');
    assert.strictEqual(entries[0].status, 'queued', 'Entry should still be queued');

    // 5. gpt52 completes via messages.ts path → onInvocationComplete
    trackerMock.clearActive('thread-1');
    await processor.onInvocationComplete('thread-1', 'gpt52', 'succeeded');
    await settle();

    // 6. The orphaned autoExecute entry should have been picked up and executed
    assert.strictEqual(routerMock.calls.length, 1, 'Orphaned autoExecute entry should be recovered');
    assert.strictEqual(routerMock.calls[0].message, 'P1 修完，请 review');
    assert.deepStrictEqual(routerMock.calls[0].targetCats, ['gpt52']);
  });

  it('one completion drain starts every consecutively unblocked strict head', async () => {
    // When gpt52 completes, tryExecuteNextAcrossUsers picks the oldest entry.
    // If that entry is for a DIFFERENT free cat (codex), it starts codex's entry.
    // The dirty-bit drain keeps owning the thread and starts the next strict head too.

    const activeSlots = new Set();
    /** @type {any} */
    const perSlotTracker = {
      start(threadId, catId) {
        activeSlots.add(`${threadId}:${catId}`);
        return new AbortController();
      },
      startAll(threadId, catIds) {
        for (const catId of catIds) activeSlots.add(`${threadId}:${catId}`);
        return new AbortController();
      },
      complete(threadId, catId, _controller) {
        activeSlots.delete(`${threadId}:${catId}`);
      },
      completeAll(threadId, catIds) {
        for (const catId of catIds) activeSlots.delete(`${threadId}:${catId}`);
      },
      has(threadId, catId) {
        if (catId) return activeSlots.has(`${threadId}:${catId}`);
        for (const key of activeSlots) {
          if (key.startsWith(`${threadId}:`)) return true;
        }
        return false;
      },
    };

    const localProcessor = new QueueProcessor({
      queue,
      invocationTracker: perSlotTracker,
      invocationRecordStore: recordMock.store,
      router: routerMock.router,
      socketManager: socketMock.manager,
      messageStore: /** @type {any} */ ({ getById: async () => null }),
      log: noopLog(),
    });

    activeSlots.add('thread-1:gpt52');
    activeSlots.add('thread-1:codex');
    activeSlots.add('thread-1:opus');

    await queue.enqueueDurable(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'agent-user',
        kind: 'private_input',
        sourceId: 'integration-codex-review',
        content: 'review request for codex',
        source: 'agent',
        targetCats: ['codex'],
        intent: 'execute',
        autoExecute: true,
      }),
    );
    await queue.enqueueDurable(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'agent-user',
        kind: 'private_input',
        sourceId: 'integration-opus-review',
        content: 'review request for opus',
        source: 'agent',
        targetCats: ['opus'],
        intent: 'execute',
        autoExecute: true,
      }),
    );

    await localProcessor.requestDrain('thread-1');
    assert.strictEqual(routerMock.calls.length, 0, 'All entries skipped — all cats busy');

    // All three cats complete at once
    activeSlots.clear();

    // Capture call count before completion
    const beforeCount = routerMock.calls.length;
    await localProcessor.onInvocationComplete('thread-1', 'gpt52', 'succeeded');

    // executeEntry calls are fire-and-forget with async gaps (emitQueueUpdated).
    // Wait for them to reach routeExecution before measuring.
    await settle(200);

    const startedFromCompletion = routerMock.calls.length - beforeCount;
    assert.strictEqual(startedFromCompletion, 2, 'Both entries should execute from the same onInvocationComplete call');
  });
});
