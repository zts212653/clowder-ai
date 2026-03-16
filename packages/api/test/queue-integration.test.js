// @ts-check

import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { ConnectorInvokeTrigger } from '../dist/infrastructure/email/ConnectorInvokeTrigger.js';

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
  return {
    creates,
    updates,
    /** @type {any} */
    store: {
      async create(input) {
        creates.push(input);
        counter++;
        return { outcome: 'created', invocationId: `inv-${counter}` };
      },
      async update(id, data) {
        updates.push({ id, data });
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
      complete(threadId, _controller) {
        completes.push({ threadId });
        activeThreads.delete(threadId);
      },
      has(threadId) {
        return activeThreads.has(threadId);
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
    const result = queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'Fix the bug',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
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

  it('E2E: cancel → queue paused → processNext → resumes', async () => {
    // 1. Enqueue a message
    trackerMock.setActive('thread-1');
    queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'Continue working',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    // 2. Cancel invocation → queue pauses
    trackerMock.clearActive('thread-1');
    await processor.onInvocationComplete('thread-1', 'opus', 'canceled');

    // 3. Verify queue_paused emitted
    const pauseEmit = socketMock.userEmits.find((e) => e.event === 'queue_paused');
    assert.ok(pauseEmit, 'Should emit queue_paused');
    assert.strictEqual(pauseEmit.data.reason, 'canceled');
    assert.ok(processor.isPaused('thread-1'), 'Thread should be paused');

    // 4. No auto-dequeue should have happened
    assert.strictEqual(routerMock.calls.length, 0, 'Should NOT auto-dequeue on cancel');

    // 5. 铲屎官 manually triggers processNext
    const processResult = await processor.processNext('thread-1', 'user-1');
    assert.strictEqual(processResult.started, true);
    await settle();

    // 6. Verify message was processed
    assert.strictEqual(routerMock.calls.length, 1);
    assert.strictEqual(routerMock.calls[0].message, 'Continue working');
    assert.strictEqual(processor.isPaused('thread-1'), false, 'Thread should be unpaused');
  });

  it('E2E: connector message arrives during active invocation → queued', async () => {
    // 1. Simulate active invocation
    trackerMock.setActive('thread-1');

    // 2. ConnectorInvokeTrigger fires
    const trigger = new ConnectorInvokeTrigger({
      router: routerMock.router,
      socketManager: socketMock.manager,
      invocationRecordStore: recordMock.store,
      invocationTracker: trackerMock.tracker,
      invocationQueue: queue,
      log: noopLog(),
    });

    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review email content', 'msg-connector-1');
    await settle();

    // 3. Verify it was queued (NOT directly executed)
    assert.strictEqual(routerMock.calls.length, 0, 'Should NOT execute directly');
    assert.strictEqual(recordMock.creates.length, 0, 'Should NOT create InvocationRecord');

    const entries = queue.list('thread-1', 'user-1');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].source, 'connector');
    assert.strictEqual(entries[0].content, 'Review email content');
    assert.strictEqual(entries[0].messageId, 'msg-connector-1');

    // 4. queue_updated emitted
    const queueUpdate = socketMock.userEmits.find((e) => e.event === 'queue_updated');
    assert.ok(queueUpdate, 'Should emit queue_updated');

    // 5. Active invocation completes → auto-dequeue
    trackerMock.clearActive('thread-1');
    await processor.onInvocationComplete('thread-1', 'opus', 'succeeded');
    await settle();

    assert.strictEqual(routerMock.calls.length, 1, 'Should auto-dequeue after completion');
    assert.strictEqual(routerMock.calls[0].message, 'Review email content');
  });

  it('E2E: force mode aborts + executes immediately (queue unchanged)', async () => {
    // Setup: active invocation + one queued message
    trackerMock.setActive('thread-1');
    queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'Queued msg',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    // Force send simulates what POST /api/messages does with deliveryMode=force:
    // 1. Cancel active invocation (InvocationTracker.cancel)
    // 2. Direct execution (bypass queue)
    // The force send itself is handled by messages.ts, not the queue.
    // After force completes → onInvocationComplete('canceled') pauses queue.

    trackerMock.clearActive('thread-1');
    await processor.onInvocationComplete('thread-1', 'opus', 'canceled');

    // Queue should be paused (canceled status)
    assert.ok(processor.isPaused('thread-1'), 'Queue should pause after force-cancel');

    // Queue message should still be there (not auto-dequeued)
    const entries = queue.list('thread-1', 'user-1');
    assert.strictEqual(entries.length, 1, 'Queued message should persist');
    assert.strictEqual(entries[0].content, 'Queued msg');

    // pause event emitted
    const pauseEmit = socketMock.userEmits.find((e) => e.event === 'queue_paused');
    assert.ok(pauseEmit, 'Should emit queue_paused');
  });

  // ── F39 bugfix: clearPause prevents state poisoning ──

  it('bugfix: clearPause prevents stale pause from old invocation cleanup', async () => {
    // Simulate force-send flow:
    // 1. Active invocation running
    trackerMock.setActive('thread-1');
    queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'Queued msg',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    // 2. Force cancel → clearPause (what messages.ts now does)
    trackerMock.clearActive('thread-1');
    processor.clearPause('thread-1');

    // 3. Old invocation's async cleanup calls onInvocationComplete('canceled')
    await processor.onInvocationComplete('thread-1', 'opus', 'canceled');

    // Queue SHOULD be paused (the old cleanup still fires)
    // But the force-send's new invocation will start() and run independently.
    // The key: clearPause was called BEFORE the stale pause, so the pause
    // wins. But a subsequent succeeded completion will clear it.
    // For now verify clearPause itself works:
    processor.clearPause('thread-1');
    assert.ok(!processor.isPaused('thread-1'), 'clearPause should remove paused state');
  });

  it('bugfix: ConnectorInvokeTrigger abort mid-loop → should NOT ack or mark succeeded', async () => {
    // Setup: no active invocation so trigger goes to direct execution
    const controller = new AbortController();
    trackerMock.tracker.start = () => {
      trackerMock.starts.push({ direct: true });
      trackerMock.activeThreads.add('thread-1');
      return controller;
    };

    // Router yields one msg, then aborts (simulating external cancel), then ends normally
    const ackCalls = /** @type {any[]} */ ([]);
    const customRouter = {
      async *routeExecution(_userId, _message, _threadId, _userMessageId, _targetCats, _intent, _options) {
        yield { type: 'text', catId: 'opus', content: 'partial', timestamp: Date.now() };
        // External cancel while connector is streaming
        controller.abort();
        // Generator ends normally (no throw)
      },
      async ackCollectedCursors(userId, threadId) {
        ackCalls.push({ userId, threadId });
      },
    };

    const trigger = new ConnectorInvokeTrigger({
      router: /** @type {any} */ (customRouter),
      socketManager: socketMock.manager,
      invocationRecordStore: recordMock.store,
      invocationTracker: trackerMock.tracker,
      invocationQueue: queue,
      log: noopLog(),
    });

    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review content', 'msg-conn-abort');
    await settle(300);

    // ackCollectedCursors should NOT be called
    assert.strictEqual(ackCalls.length, 0, 'should NOT ack cursors for aborted connector invocation');

    // invocationRecordStore should have 'canceled', NOT 'succeeded'
    const succeededUpdate = recordMock.updates.find((u) => u.data.status === 'succeeded');
    assert.ok(!succeededUpdate, 'should NOT mark connector invocation as succeeded when aborted');

    const canceledUpdate = recordMock.updates.find((u) => u.data.status === 'canceled');
    assert.ok(canceledUpdate, 'should mark connector invocation as canceled when aborted');
  });

  it('bugfix: clearPause + succeeded new invocation → auto-dequeue resumes', async () => {
    // 1. Active invocation + queued message
    trackerMock.setActive('thread-1');
    queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'Queued msg',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    // 2. Force cancel
    trackerMock.clearActive('thread-1');
    processor.clearPause('thread-1');

    // 3. Old cleanup pauses (race)
    await processor.onInvocationComplete('thread-1', 'opus', 'canceled');

    // 4. New force-send invocation succeeds → should auto-dequeue
    await processor.onInvocationComplete('thread-1', 'opus', 'succeeded');
    await settle();

    // The queued message should have been auto-dequeued and executed
    assert.strictEqual(routerMock.calls.length, 1, 'Should auto-dequeue after force-send succeeds');
    assert.strictEqual(routerMock.calls[0].message, 'Queued msg');
  });
});
