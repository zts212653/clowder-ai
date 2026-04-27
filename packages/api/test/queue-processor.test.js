import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

/** Build a stub deps object for QueueProcessor */
function stubDeps(overrides = {}) {
  return {
    queue: new InvocationQueue(),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: 'msg-stub' })),
      getById: mock.fn(async () => null),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
  };
}

/** Helper: enqueue an entry and return it */
function enqueueEntry(queue, overrides = {}) {
  const result = queue.enqueue({
    threadId: 't1',
    userId: 'u1',
    content: 'hello',
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  });
  return result.entry;
}

describe('QueueProcessor', () => {
  let deps;
  let processor;

  beforeEach(() => {
    deps = stubDeps();
    processor = new QueueProcessor(deps);
  });

  // ── onInvocationComplete ──

  it('succeeded + queue has entries → auto-dequeues and starts execution', async () => {
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    // Should have started execution (invocationTracker.start called)
    assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0);
    // Entry should be marked processing then removed
    // Wait a tick for background execution
    await new Promise((r) => setTimeout(r, 50));
  });

  it('succeeded + empty queue → no action', async () => {
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0);
  });

  it('canceled → pauses queue, emits queue_paused', async () => {
    enqueueEntry(deps.queue);

    await processor.onInvocationComplete('t1', 'opus', 'canceled');

    // Should NOT start new execution
    assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0);
    // Should emit queue_paused
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    assert.ok(emitCalls.length > 0);
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.ok(pausedCall, 'should emit queue_paused');
    assert.equal(pausedCall.arguments[2].reason, 'canceled');
  });

  it('canceled_by_user → auto-dequeues and does not emit queue_paused', async () => {
    deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'resume after cancel',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user');
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0, 'user cancel should auto-resume queued work');
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.equal(pausedCall, undefined, 'user cancel should not pause the queue');
  });

  it('canceled with processing-only queue → does not emit queue_paused', async () => {
    enqueueEntry(deps.queue);
    // Simulate steer immediate: queued entry is promoted to processing before the canceled cleanup runs.
    deps.queue.markProcessing('t1', 'u1');

    await processor.onInvocationComplete('t1', 'opus', 'canceled');

    assert.equal(processor.isPaused('t1'), false);
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.equal(pausedCall, undefined);
  });

  it('user cancel during queued execution stops broadcasting late agent events', async () => {
    let controller;
    deps.invocationTracker.startAll.mock.mockImplementation(() => {
      controller = new AbortController();
      return controller;
    });
    deps.router.routeExecution = mock.fn(async function* () {
      yield { type: 'text', catId: 'opus', content: 'before cancel', timestamp: Date.now() };
      controller.abort('user_cancel');
      yield { type: 'text', catId: 'opus', content: 'after cancel', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
    });

    enqueueEntry(deps.queue);

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const broadcasts = deps.socketManager.broadcastAgentMessage.mock.calls.map((call) => call.arguments[0]);
    assert.ok(
      broadcasts.some((msg) => msg.type === 'text' && msg.content === 'before cancel'),
      'pre-cancel text should be broadcast',
    );
    assert.equal(
      broadcasts.some((msg) => msg.type === 'text' && msg.content === 'after cancel'),
      false,
      'post-cancel text must not be broadcast',
    );
    assert.equal(
      broadcasts.some((msg) => msg.type === 'done' && msg.catId === 'opus'),
      false,
      'post-cancel done from the stale producer must not be broadcast',
    );

    const canceledUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (call) => call.arguments[1]?.status === 'canceled',
    );
    assert.ok(canceledUpdate, 'aborted queued invocation should be recorded as canceled');
  });

  it('failed → pauses queue, emits queue_paused', async () => {
    enqueueEntry(deps.queue);

    await processor.onInvocationComplete('t1', 'opus', 'failed');

    assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0);
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.ok(pausedCall);
    assert.equal(pausedCall.arguments[2].reason, 'failed');
  });

  // ── processNext ──

  it('processNext starts next entry when paused', async () => {
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    assert.ok(result.entry);
  });

  it('queued execution broadcasts intent_mode with invocationId when processing starts', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['codex'], intent: 'execute' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 50));

    const intentCall = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.ok(intentCall, 'should broadcast intent_mode for queued execution');
    assert.deepEqual(intentCall.arguments[2], {
      threadId: 't1',
      mode: 'execute',
      targetCats: ['codex'],
      invocationId: 'inv-stub',
    });
  });

  it('emits queue_updated(action=completed) after entry is removed from queue', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['codex'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 50));

    const queueUpdates = deps.socketManager.emitToUser.mock.calls
      .filter((c) => c.arguments[1] === 'queue_updated')
      .map((c) => c.arguments[2]);
    const completed = queueUpdates.find((u) => u.action === 'completed');
    assert.ok(completed, 'should emit queue_updated completed after cleanup');
    assert.equal(completed.threadId, 't1');
    assert.deepEqual(completed.queue, [], 'queue snapshot should be empty after processed entry cleanup');
  });

  it('processNext returns started=false when queue empty', async () => {
    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, false);
  });

  // ── Mutex ──

  it('concurrent tryExecuteNext on same thread + same cat → only one starts (F108: per-slot mutex)', async () => {
    // Make executeEntry slow
    const slowDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          await new Promise((r) => setTimeout(r, 100));
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const slowProcessor = new QueueProcessor(slowDeps);

    // Both entries target same cat → same slot key
    enqueueEntry(slowDeps.queue, { content: 'a', targetCats: ['opus'] });
    enqueueEntry(slowDeps.queue, { content: 'b', targetCats: ['opus'] });

    // Fire two processNext concurrently
    const [r1, r2] = await Promise.all([slowProcessor.processNext('t1', 'u1'), slowProcessor.processNext('t1', 'u1')]);

    // One should start, other should not (per-slot mutex)
    const startedCount = [r1, r2].filter((r) => r.started).length;
    assert.equal(startedCount, 1, 'only one should start due to per-slot mutex');
  });

  // ── executeEntry creates InvocationRecord ──

  it('executeEntry creates InvocationRecord with queue idempotency key', async () => {
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const createCalls = deps.invocationRecordStore.create.mock.calls;
    assert.ok(createCalls.length > 0);
    const createArg = createCalls[0].arguments[0];
    assert.ok(createArg.idempotencyKey.startsWith('queue-'));
  });

  it('connector-sourced entry uses connector-${messageId} idempotency key', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'connector' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-conn-1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const createCalls = deps.invocationRecordStore.create.mock.calls;
    assert.ok(createCalls.length > 0);
    const createArg = createCalls[0].arguments[0];
    assert.strictEqual(createArg.idempotencyKey, 'connector-msg-conn-1');
  });

  // ── P1-2 fix: isPaused state tracking ──

  it('isPaused returns true after canceled when queue has entries', async () => {
    enqueueEntry(deps.queue);
    assert.equal(processor.isPaused('t1'), false);

    await processor.onInvocationComplete('t1', 'opus', 'canceled');
    assert.equal(processor.isPaused('t1'), true);

    // processNext clears paused
    await processor.processNext('t1', 'u1');
    assert.equal(processor.isPaused('t1'), false);
  });

  it('isPaused returns false when queue is empty even after failed', async () => {
    // No entries in queue — no pause should be persisted
    await processor.onInvocationComplete('t1', 'opus', 'failed');
    assert.equal(processor.isPaused('t1'), false);

    // Add entry → still not paused
    enqueueEntry(deps.queue);
    assert.equal(processor.isPaused('t1'), false);

    // Succeeded clears paused flag
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    assert.equal(processor.isPaused('t1'), false);
  });

  // ── P1 fix: chain auto-dequeue ──

  it('chain auto-dequeue: entry1 succeed → entry2 auto-starts', async () => {
    // Enqueue two entries from different users
    const e1 = enqueueEntry(deps.queue, { userId: 'u1', content: 'first', targetCats: ['a'] });
    deps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-1');
    const e2 = enqueueEntry(deps.queue, { userId: 'u2', content: 'second', targetCats: ['b'] });
    deps.queue.backfillMessageId('t1', 'u2', e2.id, 'msg-2');

    // Trigger first entry via onInvocationComplete('succeeded')
    await processor.onInvocationComplete('t1', 'a', 'succeeded');

    // Wait for both executions to complete (e1 finishes → chains → e2 starts)
    await new Promise((r) => setTimeout(r, 200));

    // Both entries should have been processed (tracker.start called twice)
    assert.ok(
      deps.invocationTracker.startAll.mock.calls.length >= 2,
      `expected >=2 tracker.start calls, got ${deps.invocationTracker.startAll.mock.calls.length}`,
    );
  });

  // ── #768: intent_mode deferred until CLI is alive ──

  it('#768 regression: intent_mode is NOT broadcast when routeExecution throws before yielding', async () => {
    const failDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          throw new Error('CLI spawn failed');
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const failProcessor = new QueueProcessor(failDeps);

    const entry = enqueueEntry(failDeps.queue);
    failDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await failProcessor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 100));

    const intentCall = failDeps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.equal(intentCall, undefined, 'intent_mode must NOT be broadcast when CLI fails before producing events');
  });

  it('#768 regression: intent_mode IS broadcast once CLI produces first event', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['codex'], intent: 'execute' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const intentCall = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.ok(intentCall, 'intent_mode should be broadcast after first CLI event');
  });

  it('#768 regression: intent_mode is NOT broadcast when routeExecution yields nothing (empty generator)', async () => {
    const emptyDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          // Generator completes without yielding any events
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const emptyProcessor = new QueueProcessor(emptyDeps);

    const entry = enqueueEntry(emptyDeps.queue);
    emptyDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await emptyProcessor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 100));

    const intentCall = emptyDeps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.equal(intentCall, undefined, 'intent_mode must NOT be broadcast when CLI produces zero events');
  });

  // ── P1 fix: executeEntry failure marks InvocationRecord ──

  it('executeEntry failure marks InvocationRecord as failed', async () => {
    const failDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          throw new Error('route boom');
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const failProcessor = new QueueProcessor(failDeps);

    const entry = enqueueEntry(failDeps.queue);
    failDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await failProcessor.processNext('t1', 'u1');
    // Wait for background execution to complete
    await new Promise((r) => setTimeout(r, 100));

    // InvocationRecord should be updated with status='failed'
    const updateCalls = failDeps.invocationRecordStore.update.mock.calls;
    const failedUpdate = updateCalls.find((c) => c.arguments[1]?.status === 'failed');
    assert.ok(failedUpdate, 'should mark InvocationRecord as failed');
    assert.ok(failedUpdate.arguments[1].error, 'should include error message');
  });

  // ── F039 remaining bugfix: queue execution should include contentBlocks ──

  it('executeEntry passes contentBlocks from messageId to routeExecution', async () => {
    const contentBlocks = [{ type: 'image', url: 'https://example.com/1.png' }];

    deps.messageStore.getById = mock.fn(async (id) => {
      if (id === 'm1') return { id: 'm1', contentBlocks };
      return null;
    });

    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'm1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(deps.router.routeExecution.mock.calls.length > 0);
    const call = deps.router.routeExecution.mock.calls[0];
    const opts = call.arguments[6];
    assert.ok(opts && typeof opts === 'object', 'expected opts object');
    assert.deepEqual(opts.contentBlocks, contentBlocks);
  });

  it('degrades when messageStore.getById throws: still executes without contentBlocks', async () => {
    deps.messageStore.getById = mock.fn(async () => {
      throw new Error('redis down');
    });

    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'm1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(deps.router.routeExecution.mock.calls.length > 0, 'should still execute');
    const call = deps.router.routeExecution.mock.calls[0];
    const opts = call.arguments[6];
    assert.ok(opts && typeof opts === 'object', 'expected opts object');
    assert.equal(opts.contentBlocks, undefined);

    const succeededUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (c) => c.arguments[1]?.status === 'succeeded',
    );
    assert.ok(succeededUpdate, 'should mark InvocationRecord succeeded');

    assert.ok(deps.log.warn.mock.calls.length > 0, 'should warn on messageStore failure');
  });

  // ── F108: QueueProcessor slot-aware (AC-A7) ──

  describe('slot-aware mutex and dequeue (F108)', () => {
    it('processing mutex is per-slot: different cats can execute concurrently in same thread', async () => {
      // Enqueue opus and codex entries for same thread
      const e1 = enqueueEntry(deps.queue, { content: 'opus task', targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-opus');
      const e2 = enqueueEntry(deps.queue, { content: 'codex task', targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', e2.id, 'msg-codex');

      // Complete opus slot → should dequeue opus entry
      await processor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // Now complete codex slot → should dequeue codex entry (not blocked by opus mutex)
      await processor.onInvocationComplete('t1', 'codex', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // Both entries should have been processed
      assert.ok(
        deps.invocationTracker.startAll.mock.calls.length >= 2,
        `expected >=2 tracker.start calls, got ${deps.invocationTracker.startAll.mock.calls.length}`,
      );
    });

    it('slot completion does not affect pause state of different slot', async () => {
      // Enqueue entries for both cats
      enqueueEntry(deps.queue, { content: 'opus task', targetCats: ['opus'] });
      enqueueEntry(deps.queue, { content: 'codex task', targetCats: ['codex'] });

      // Cancel opus slot — should pause opus, not codex
      await processor.onInvocationComplete('t1', 'opus', 'canceled');

      // opus slot should be paused
      assert.equal(processor.isPaused('t1', 'opus'), true);
      // codex slot should NOT be paused
      assert.equal(processor.isPaused('t1', 'codex'), false);
    });

    it('clearPause is slot-specific', () => {
      // Manually set both paused
      processor.clearPause('t1', 'opus');
      // Should not throw, just noop
      assert.equal(processor.isPaused('t1', 'opus'), false);
    });

    it('releaseSlot is slot-specific', async () => {
      const slowDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            await new Promise((r) => setTimeout(r, 200));
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      // Enqueue opus and codex
      const e1 = enqueueEntry(slowDeps.queue, { content: 'opus slow', targetCats: ['opus'] });
      slowDeps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-1');
      const e2 = enqueueEntry(slowDeps.queue, { content: 'codex fast', targetCats: ['codex'] });
      slowDeps.queue.backfillMessageId('t1', 'u1', e2.id, 'msg-2');

      // Start opus via processNext — takes mutex for opus slot
      await slowProcessor.processNext('t1', 'u1');

      // Release opus slot — should allow another opus entry to start
      slowProcessor.releaseSlot('t1', 'opus');

      // codex should still be startable (no mutex on codex slot)
      const r2 = await slowProcessor.processNext('t1', 'u1');
      assert.equal(r2.started, true, 'codex entry should start since opus slot was released');
    });

    it('onInvocationComplete requires catId parameter', async () => {
      enqueueEntry(deps.queue);

      // New signature: onInvocationComplete(threadId, catId, status)
      await processor.onInvocationComplete('t1', 'opus', 'succeeded');
      // Should not throw — catId is now required
    });

    it('tryExecuteNextAcrossUsers checks entryCat slot, not just completing cat slot (P1-2)', async () => {
      // Scenario: opus completes, oldest queued entry targets codex, but codex is already running.
      // Bug: code checks completing cat (opus) slot mutex, not the entry's cat (codex).
      // Expected: should NOT start codex entry when codex slot is busy.

      // Make routeExecution hang so codex stays "in progress"
      let resolveCodex;
      deps.router.routeExecution = mock.fn(async function* () {
        await new Promise((r) => {
          resolveCodex = r;
        });
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      });

      const codexEntry = enqueueEntry(deps.queue, { targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', codexEntry.id, 'msg-codex');

      // Start codex — it hangs (slot is busy)
      await processor.processNext('t1', 'u1');

      // Enqueue another codex entry while the first is still running
      const codexEntry2 = enqueueEntry(deps.queue, { targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', codexEntry2.id, 'msg-codex2');

      // Simulate opus completing — triggers auto-dequeue across users
      // Oldest remaining queued entry is codex, but codex slot is busy
      await processor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // routeExecution should only have been called once (for the first codex entry)
      const routeCalls = deps.router.routeExecution.mock.calls;
      assert.equal(routeCalls.length, 1, `should not double-start codex slot; got ${routeCalls.length} route calls`);

      // Cleanup: resolve the hanging codex execution
      resolveCodex?.();
    });

    it('tryExecuteNextForUser does not leave entry stuck in processing when slot is busy (P1-3)', async () => {
      // Scenario: codex is already running, user sends another message targeting codex.
      // Bug: markProcessing() called before mutex check, entry gets stuck as 'processing'.
      // Expected: entry should remain 'queued' if slot is busy.

      // Make routeExecution hang so codex stays "in progress"
      let resolveCodex;
      deps.router.routeExecution = mock.fn(async function* () {
        await new Promise((r) => {
          resolveCodex = r;
        });
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      });

      const entry1 = enqueueEntry(deps.queue, { targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', entry1.id, 'msg-1');

      // Process entry1 — codex slot becomes busy (hangs)
      await processor.processNext('t1', 'u1');

      // Use different intent to prevent auto-merge with entry1
      const entry2res = deps.queue.enqueue({
        threadId: 't1',
        userId: 'u1',
        content: 'second message',
        source: 'user',
        targetCats: ['codex'],
        intent: 'ideate',
      });
      const entry2 = entry2res.entry;
      deps.queue.backfillMessageId('t1', 'u1', entry2.id, 'msg-2');

      // Try to process entry2 while codex slot is busy
      const result = await processor.processNext('t1', 'u1');
      assert.equal(result.started, false, 'should not start when slot is busy');

      // Key assertion: entry2 should still be 'queued', not stuck as 'processing'
      const list = deps.queue.list('t1', 'u1');
      const entry2Status = list.find((e) => e.id === entry2.id);
      assert.ok(entry2Status, 'entry2 should still be in queue');
      assert.equal(entry2Status.status, 'queued', 'entry2 should remain queued, not stuck as processing');

      // Cleanup
      resolveCodex?.();
    });

    it('broadcast messages carry invocationId (AC-A8)', async () => {
      const entry = enqueueEntry(deps.queue);
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await processor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 50));

      const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
      assert.ok(broadcastCalls.length > 0, 'should have broadcast at least one message');
      const msgArg = broadcastCalls[0].arguments[0];
      assert.equal(msgArg.invocationId, 'inv-stub', 'broadcast message should carry invocationId');
    });
  });

  // ── F122B: tryAutoExecute ──

  describe('tryAutoExecute (F122B agent auto-execute)', () => {
    it('immediately executes autoExecute entry when target cat slot is free', async () => {
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'codex',
      });

      await processor.tryAutoExecute('t1');
      // Give fire-and-forget a tick
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0, 'should start execution');
    });

    it('does not execute autoExecute entry when target cat slot is busy', async () => {
      // Occupy opus slot
      deps.invocationTracker.has = mock.fn(() => true);
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'codex',
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      // Entry stays queued, not executed
      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0, 'should not start when slot busy');
      const queued = deps.queue.list('t1', 'system');
      assert.equal(queued.length, 1, 'entry should remain in queue');
      assert.equal(queued[0].status, 'queued', 'entry should still be queued');
    });

    it('skips non-autoExecute entries', async () => {
      enqueueEntry(deps.queue, {
        userId: 'u1',
        source: 'user',
        targetCats: ['opus'],
        // no autoExecute
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0, 'should not execute user entries');
    });

    it('skips stale queued autoExecute entries older than threshold', async () => {
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'codex',
      });
      // list() returns shallow-copied array with reference elements — mutating
      // createdAt here reaches the real entry inside the queue (coupling on purpose).
      const queued = deps.queue.list('t1', 'system');
      queued[0].createdAt = Date.now() - 120_000;

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0, 'stale autoExecute entry must not start');
      const stillQueued = deps.queue.list('t1', 'system');
      assert.equal(stillQueued.length, 1);
      assert.equal(stillQueued[0].status, 'queued');
    });

    it('autoExecute entry bypasses pause state', async () => {
      // Set up a paused state
      enqueueEntry(deps.queue, { userId: 'u1', source: 'user' });
      await processor.onInvocationComplete('t1', 'opus', 'failed');
      assert.ok(processor.isPaused('t1', 'opus'), 'should be paused');

      // Now enqueue an agent auto-execute entry
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'], // different cat slot — not paused
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(
        deps.invocationTracker.startAll.mock.calls.length > 0,
        'should execute on free slot despite thread pause',
      );
    });

    it('skips busy-slot entry and executes next free-slot autoExecute entry (P2 scan)', async () => {
      // Entry 1: opus slot busy
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'gemini',
      });
      // Entry 2: codex slot free
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'gemini',
      });

      // Mock: opus is busy, codex is free
      deps.invocationTracker.has = mock.fn((threadId, catId) => catId === 'opus');

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      // First start should be codex (skipped opus because slot is busy)
      assert.ok(deps.invocationTracker.startAll.mock.calls.length >= 1, 'should start at least one');
      const firstStartCall = deps.invocationTracker.startAll.mock.calls[0];
      // startAll receives catIds[] as second arg
      assert.deepEqual(firstStartCall.arguments[1], ['codex'], 'should start codex (free slot) first, not opus (busy)');
    });

    it('starts multiple free-slot entries in a single tryAutoExecute call (parallel dispatch)', async () => {
      // Enqueue 3 entries for 3 different cats — all slots free
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'gemini',
      });
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'gemini',
      });
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['gemini'],
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 100));

      // All 3 should have been started (different cat slots, all free)
      const startCalls = deps.invocationTracker.startAll.mock.calls;
      assert.equal(startCalls.length, 3, 'should start all 3 entries in one call');
      // startAll receives catIds[] as second arg — flatten to get primary cats
      const startedCats = startCalls.map((c) => c.arguments[1][0]);
      assert.ok(startedCats.includes('opus'), 'opus should be started');
      assert.ok(startedCats.includes('codex'), 'codex should be started');
      assert.ok(startedCats.includes('gemini'), 'gemini should be started');
    });
  });

  // ── Tracker guard: prevent duplicate execution for CLI-active cats ──

  describe('tracker guard on completion chain (tryExecuteNextAcrossUsers)', () => {
    it('does NOT start queued entry when target cat has active CLI invocation', async () => {
      // Simulate: opus is running via CLI (tracked in invocationTracker but NOT in processingSlots)
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      // invocationTracker reports opus is active (CLI invocation)
      deps.invocationTracker.has = mock.fn((_tid, catId) => catId === 'opus');

      // codex completes → triggers tryExecuteNextAcrossUsers which finds the opus entry
      await processor.onInvocationComplete('t1', 'codex', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // executeEntry must NOT have been called
      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        0,
        'must not call executeEntry (tracker.start not called)',
      );
      assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'must not call routeExecution');

      // Entry must be rolled back to queued (not stuck as processing)
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 1);
      assert.equal(queue[0].status, 'queued', 'entry must rollback to queued');
    });
  });

  describe('tracker guard on processNext (tryExecuteNextForUser)', () => {
    it('does NOT start queued entry when target cat has active CLI invocation', async () => {
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      // invocationTracker reports opus is active (CLI invocation)
      deps.invocationTracker.has = mock.fn((_tid, catId) => catId === 'opus');

      const result = await processor.processNext('t1', 'u1');

      assert.equal(result.started, false, 'must not start when tracker has active invocation');
      // executeEntry must NOT have been called
      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        0,
        'must not call executeEntry (tracker.start not called)',
      );
      assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'must not call routeExecution');

      // Entry must still be queued (never marked processing since guard fires before markProcessing)
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 1);
      assert.equal(queue[0].status, 'queued', 'entry must remain queued');
    });
  });

  // ── F088 fix: OutboundDeliveryHook regression tests ──

  describe('outbound delivery via QueueProcessor (F088)', () => {
    /** Poll until predicate returns true or timeout (deterministic, no fixed sleeps). */
    async function waitFor(predicate, timeoutMs = 5000, intervalMs = 10) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }

    it('single-cat execution: outboundHook.deliver called once with correct catId + content', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId, richBlocks, threadMeta) => {
          deliverCalls.push({ threadId, content, catId, richBlocks, threadMeta });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };
      const threadMetaLookup = mock.fn(async () => ({
        threadShortId: 't1-short',
        threadTitle: 'Test Thread',
        deepLinkUrl: 'https://example.com/threads/t1',
      }));

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Hello from opus', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup,
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 1);

      assert.equal(deliverCalls.length, 1, 'deliver should be called once for single-cat execution');
      assert.equal(deliverCalls[0].threadId, 't1');
      assert.equal(deliverCalls[0].catId, 'opus');
      assert.equal(deliverCalls[0].content, 'Hello from opus');
      assert.ok(deliverCalls[0].threadMeta, 'threadMeta should be provided');
      assert.equal(deliverCalls[0].threadMeta.threadTitle, 'Test Thread');

      assert.ok(streamingHook.onStreamStart.mock.calls.length >= 1, 'onStreamStart should be called');
      assert.ok(streamingHook.onStreamEnd.mock.calls.length >= 1, 'onStreamEnd should be called');

      await waitFor(() => streamingHook.cleanupPlaceholders.mock.calls.length >= 1);
      assert.ok(
        streamingHook.cleanupPlaceholders.mock.calls.length >= 1,
        'cleanupPlaceholders should be called on successful delivery',
      );
    });

    it('replace-mode text overwrites server-side aggregated outbound and streaming content', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: '第一段。第二段。', timestamp: Date.now() };
            yield {
              type: 'text',
              catId: 'opus',
              content: '第一段。插入一句。第二段。',
              textMode: 'replace',
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 1);

      assert.equal(deliverCalls[0].content, '第一段。插入一句。第二段。');
      const lastChunkCall = streamingHook.onStreamChunk.mock.calls.at(-1);
      assert.ok(lastChunkCall, 'streaming hook should receive chunks');
      assert.equal(lastChunkCall.arguments[1], '第一段。插入一句。第二段。');
      const endCall = streamingHook.onStreamEnd.mock.calls.at(-1);
      assert.ok(endCall, 'streaming hook should receive final end');
      assert.equal(endCall.arguments[1], '第一段。插入一句。第二段。');
    });

    it('multi-cat execution: outboundHook.deliver called per-turn with each catId', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId, richBlocks, threadMeta) => {
          deliverCalls.push({ threadId, content, catId, richBlocks, threadMeta });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Opus says hi. ', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'Codex chimes in.', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 2);

      assert.equal(deliverCalls.length, 2, 'deliver should be called once per cat turn');
      assert.equal(deliverCalls[0].catId, 'opus', 'first deliver should be for opus');
      assert.equal(deliverCalls[0].content, 'Opus says hi. ', 'opus content should match');
      assert.equal(deliverCalls[1].catId, 'codex', 'second deliver should be for codex');
      assert.equal(deliverCalls[1].content, 'Codex chimes in.', 'codex content should match');
    });

    it('BUG-5: multi-turn delivers per-turn (no merge needed, token reusable)', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Opus says hi. ', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'Codex chimes in.', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 2);

      assert.equal(deliverCalls.length, 2, 'Multi-turn delivers per-turn');
      assert.strictEqual(deliverCalls[0].catId, 'opus');
      assert.ok(deliverCalls[0].content.includes('Opus says hi.'));
      assert.strictEqual(deliverCalls[1].catId, 'codex');
      assert.ok(deliverCalls[1].content.includes('Codex chimes in.'));
    });

    it('no outboundHook: execution completes normally without delivery', async () => {
      const entry = enqueueEntry(deps.queue);
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await processor.processNext('t1', 'u1');
      await waitFor(() =>
        deps.invocationRecordStore.update.mock.calls.some((c) => c.arguments[1]?.status === 'succeeded'),
      );

      const updateCalls = deps.invocationRecordStore.update.mock.calls;
      const succeededUpdate = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
      assert.ok(succeededUpdate, 'should succeed even without outboundHook');
    });

    it('delivery failure: cleanupPlaceholders NOT called when delivery partially fails', async () => {
      // F151: mid-loop delivery retries failed turns in the final phase,
      // so use catId-based failure to ensure opus consistently fails.
      const outboundHook = {
        deliver: mock.fn(async (_threadId, _content, catId) => {
          if (catId === 'opus') throw new Error('delivery failed');
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Turn 1. ', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'Turn 2.', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      // F151: mid-loop delivers both, opus fails and retries in final phase = 3 calls total
      await waitFor(() => outboundHook.deliver.mock.calls.length >= 3);

      assert.equal(outboundHook.deliver.mock.calls.length, 3, 'mid-loop (2) + final-phase retry (1)');

      // One rejection → Promise.allSettled sees mixed results → cleanupPlaceholders skipped
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(
        streamingHook.cleanupPlaceholders.mock.calls.length,
        0,
        'cleanupPlaceholders should NOT be called when delivery partially fails',
      );
    });

    it('all deliveries succeed: cleanupPlaceholders called', async () => {
      const outboundHook = {
        deliver: mock.fn(async () => {}),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Success text', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => streamingHook.cleanupPlaceholders.mock.calls.length >= 1);

      assert.equal(outboundHook.deliver.mock.calls.length, 1, 'deliver called once');
      assert.ok(
        streamingHook.cleanupPlaceholders.mock.calls.length >= 1,
        'cleanupPlaceholders should be called when all deliveries succeed',
      );
    });

    it('outboundHook set via late-bind setOutboundHook: deliver is called', async () => {
      const lateDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Late-bound delivery', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const lateProcessor = new QueueProcessor(lateDeps);

      const deliverCalls = [];
      lateProcessor.setOutboundHook({
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      });

      const entry = enqueueEntry(lateDeps.queue);
      lateDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await lateProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 1);

      assert.equal(deliverCalls.length, 1, 'late-bound hook should be called');
      assert.equal(deliverCalls[0].content, 'Late-bound delivery');
    });

    it('P2-1 regression: failed invocation still triggers notifyDeliveryBatchDone', async () => {
      const batchDoneCalls = [];
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
        notifyDeliveryBatchDone: mock.fn(async (threadId, chainDone) => {
          batchDoneCalls.push({ threadId, chainDone });
        }),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            throw new Error('invocation crashed');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => batchDoneCalls.length >= 1);

      assert.equal(batchDoneCalls.length, 1, 'notifyDeliveryBatchDone must fire on failure');
      assert.equal(batchDoneCalls[0].threadId, 't1');
      assert.equal(batchDoneCalls[0].chainDone, true, 'single invocation failure → chainDone=true');
    });

    it('P3-P2: reject callback (executeEntry throws in finally) still triggers notifyDeliveryBatchDone', async () => {
      const batchDoneCalls = [];
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
        notifyDeliveryBatchDone: mock.fn(async (threadId, chainDone) => {
          batchDoneCalls.push({ threadId, chainDone });
        }),
      };

      // Make invocationTracker.complete throw in finally block → executeEntry rejects
      const hookDeps = stubDeps({
        invocationTracker: {
          start: mock.fn(() => new AbortController()),
          complete: mock.fn(() => {
            throw new Error('tracker.complete crashed');
          }),
          has: mock.fn(() => false),
        },
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => batchDoneCalls.length >= 1);

      assert.equal(batchDoneCalls.length, 1, 'reject callback must also fire notifyDeliveryBatchDone');
      assert.equal(batchDoneCalls[0].threadId, 't1');
    });
  });

  // ── F175 Task 5: user-message batching at dequeue ──

  describe('user-message batching (F175)', () => {
    async function waitForQueue(queue, threadId, userId, predicate, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate(queue.list(threadId, userId))) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`waitForQueue timed out after ${timeoutMs}ms`);
    }

    it('combines adjacent user entries into single routeExecution call', async () => {
      enqueueEntry(deps.queue, { content: 'msg-a' });
      enqueueEntry(deps.queue, { content: 'msg-b' });
      enqueueEntry(deps.queue, { content: 'msg-c' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', (q) => deps.router.routeExecution.mock.calls.length >= 1);

      assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'should call routeExecution once');
      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'msg-a\nmsg-b\nmsg-c', 'content should be combined');
    });

    it('marks all batched entries as processing', async () => {
      enqueueEntry(deps.queue, { content: 'a' });
      enqueueEntry(deps.queue, { content: 'b' });

      await processor.processNext('t1', 'u1');

      const remaining = deps.queue.list('t1', 'u1').filter((e) => e.status === 'queued');
      assert.equal(remaining.length, 0, 'no queued entries should remain after batch');
    });

    it('does not batch connector entries', async () => {
      enqueueEntry(deps.queue, { content: 'conn-a', source: 'connector' });
      enqueueEntry(deps.queue, { content: 'conn-b', source: 'connector' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'conn-a', 'connector entries should not be batched');
      assert.equal(deps.queue.list('t1', 'u1').filter((e) => e.status === 'queued').length, 1);
    });

    it('stops batch at different intent', async () => {
      enqueueEntry(deps.queue, { content: 'exec-a', intent: 'execute' });
      enqueueEntry(deps.queue, { content: 'search-b', intent: 'search' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'exec-a', 'should only include matching-intent entries');
    });

    it('removes all batched entries after successful execution', async () => {
      enqueueEntry(deps.queue, { content: 'a' });
      enqueueEntry(deps.queue, { content: 'b' });
      enqueueEntry(deps.queue, { content: 'c' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', (q) => q.length === 0);

      const all = deps.queue.list('t1', 'u1');
      assert.equal(all.length, 0, 'all batched entries should be removed after completion');
    });

    it('P1: failed execution rolls back batched entries instead of dropping them', async () => {
      const failDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            throw new Error('CLI spawn failed');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const failProcessor = new QueueProcessor(failDeps);

      enqueueEntry(failDeps.queue, { content: 'primary' });
      enqueueEntry(failDeps.queue, { content: 'batched-a' });
      enqueueEntry(failDeps.queue, { content: 'batched-b' });

      await failProcessor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 100));

      const remaining = failDeps.queue.list('t1', 'u1');
      const queued = remaining.filter((e) => e.status === 'queued');
      assert.ok(queued.length >= 2, `batched entries should be rolled back to queued, got ${queued.length}`);
      const contents = queued.map((e) => e.content);
      assert.ok(contents.includes('batched-a'), 'batched-a should be preserved');
      assert.ok(contents.includes('batched-b'), 'batched-b should be preserved');
    });

    it('P1-1: batched entries messageIds are markDelivered-ed', async () => {
      deps.messageStore.markDelivered = mock.fn(async (id) => ({
        id,
        content: 'c',
        catId: null,
        timestamp: Date.now(),
        mentions: [],
        userId: 'u1',
      }));

      const e1 = enqueueEntry(deps.queue, { content: 'first' });
      deps.queue.backfillMessageId('t1', 'u1', e1.id, 'm1');
      const e2 = enqueueEntry(deps.queue, { content: 'second' });
      deps.queue.backfillMessageId('t1', 'u1', e2.id, 'm2');

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.messageStore.markDelivered.mock.calls.length >= 2);

      const deliveredIds = deps.messageStore.markDelivered.mock.calls.map((c) => c.arguments[0]);
      assert.ok(deliveredIds.includes('m1'), 'primary entry messageId should be delivered');
      assert.ok(deliveredIds.includes('m2'), 'batched entry messageId should be delivered');
    });

    it('P1-2: connector entry is NOT absorbed into user batch', async () => {
      enqueueEntry(deps.queue, { content: 'user-msg', source: 'user' });
      enqueueEntry(deps.queue, { content: 'connector-msg', source: 'connector' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'user-msg', 'connector entry must not be batched into user content');
      assert.equal(
        deps.queue.list('t1', 'u1').filter((e) => e.status === 'queued').length,
        1,
        'connector entry should remain queued',
      );
    });

    it('P2: urgent entry for busy slot does not block lower-priority entry for free slot', async () => {
      const slowDeps = stubDeps({
        invocationTracker: {
          start: mock.fn(() => new AbortController()),
          startAll: mock.fn(() => new AbortController()),
          complete: mock.fn(),
          completeAll: mock.fn(),
          has: mock.fn((tid, catId) => catId === 'codex'),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      // urgent entry for codex (slot busy), normal entry for opus (slot free)
      enqueueEntry(slowDeps.queue, { content: 'urgent-codex', targetCats: ['codex'], priority: 'urgent' });
      enqueueEntry(slowDeps.queue, { content: 'normal-opus', targetCats: ['opus'], priority: 'normal' });

      // Trigger across-users chain (simulates codex slot completing, then scanning queue)
      // codex is still busy (has() returns true), opus is free
      await slowProcessor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 100));

      // opus entry should execute despite urgent codex being first in sort order
      const routeCalls = slowDeps.router.routeExecution.mock.calls;
      assert.ok(routeCalls.length >= 1, 'should execute free-slot entry');
      const calledContent = routeCalls[0].arguments[1];
      assert.equal(calledContent, 'normal-opus', 'should execute opus entry, skipping busy codex');

      // codex entry should remain queued
      const codexEntries = slowDeps.queue.list('t1', 'u1').filter((e) => e.content === 'urgent-codex');
      assert.equal(codexEntries.length, 1, 'codex entry should remain');
      assert.equal(codexEntries[0].status, 'queued', 'codex entry should still be queued');
    });

    it('P1: duplicate primary does not mark batched entries as processing', async () => {
      let callCount = 0;
      const dupeDeps = stubDeps({
        invocationRecordStore: {
          create: mock.fn(async () => {
            callCount++;
            if (callCount === 1) return { outcome: 'duplicate', invocationId: 'inv-dupe' };
            return { outcome: 'created', invocationId: `inv-${callCount}` };
          }),
          update: mock.fn(async () => {}),
        },
      });
      const dupeProcessor = new QueueProcessor(dupeDeps);

      enqueueEntry(dupeDeps.queue, { content: 'a' });
      enqueueEntry(dupeDeps.queue, { content: 'b' });
      enqueueEntry(dupeDeps.queue, { content: 'c' });

      await dupeProcessor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 100));

      // Entry 'a' hits duplicate → returns early. With the fix, b and c are NOT
      // marked processing on the duplicate path. The chain then dequeues b (non-duplicate),
      // which batches c. So routeExecution sees b+c content, not a+b+c.
      const routeCalls = dupeDeps.router.routeExecution.mock.calls;
      assert.ok(routeCalls.length >= 1, 'chain should process remaining entries');
      const calledContent = routeCalls[0].arguments[1];
      assert.ok(!calledContent.includes('a'), 'duplicate entry content must not appear in batched execution');
    });
  });
});
