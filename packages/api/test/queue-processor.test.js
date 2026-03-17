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
      complete: mock.fn(),
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
    assert.ok(deps.invocationTracker.start.mock.calls.length > 0);
    // Entry should be marked processing then removed
    // Wait a tick for background execution
    await new Promise((r) => setTimeout(r, 50));
  });

  it('succeeded + empty queue → no action', async () => {
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    assert.equal(deps.invocationTracker.start.mock.calls.length, 0);
  });

  it('canceled → pauses queue, emits queue_paused', async () => {
    enqueueEntry(deps.queue);

    await processor.onInvocationComplete('t1', 'opus', 'canceled');

    // Should NOT start new execution
    assert.equal(deps.invocationTracker.start.mock.calls.length, 0);
    // Should emit queue_paused
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    assert.ok(emitCalls.length > 0);
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.ok(pausedCall, 'should emit queue_paused');
    assert.equal(pausedCall.arguments[2].reason, 'canceled');
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

  it('failed → pauses queue, emits queue_paused', async () => {
    enqueueEntry(deps.queue);

    await processor.onInvocationComplete('t1', 'opus', 'failed');

    assert.equal(deps.invocationTracker.start.mock.calls.length, 0);
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
      deps.invocationTracker.start.mock.calls.length >= 2,
      `expected >=2 tracker.start calls, got ${deps.invocationTracker.start.mock.calls.length}`,
    );
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

  it('executeEntry passes aggregated contentBlocks (messageId + mergedMessageIds) to routeExecution', async () => {
    const contentBlocks1 = [{ type: 'image', url: 'https://example.com/1.png' }];
    const contentBlocks2 = [{ type: 'image', url: 'https://example.com/2.png' }];

    deps.messageStore.getById = mock.fn(async (id) => {
      if (id === 'm1') return { id: 'm1', contentBlocks: contentBlocks1 };
      if (id === 'm2') return { id: 'm2', contentBlocks: contentBlocks2 };
      return null;
    });

    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'm1');
    deps.queue.appendMergedMessageId('t1', 'u1', entry.id, 'm2');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(deps.router.routeExecution.mock.calls.length > 0);
    const call = deps.router.routeExecution.mock.calls[0];
    const opts = call.arguments[6];
    assert.ok(opts && typeof opts === 'object', 'expected opts object');
    assert.deepEqual(opts.contentBlocks, [...contentBlocks1, ...contentBlocks2]);
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
        deps.invocationTracker.start.mock.calls.length >= 2,
        `expected >=2 tracker.start calls, got ${deps.invocationTracker.start.mock.calls.length}`,
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

      assert.ok(deps.invocationTracker.start.mock.calls.length > 0, 'should start execution');
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
      assert.equal(deps.invocationTracker.start.mock.calls.length, 0, 'should not start when slot busy');
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

      assert.equal(deps.invocationTracker.start.mock.calls.length, 0, 'should not execute user entries');
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

      assert.ok(deps.invocationTracker.start.mock.calls.length > 0, 'should execute on free slot despite thread pause');
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
      assert.ok(deps.invocationTracker.start.mock.calls.length >= 1, 'should start at least one');
      const firstStartCall = deps.invocationTracker.start.mock.calls[0];
      assert.equal(firstStartCall.arguments[1], 'codex', 'should start codex (free slot) first, not opus (busy)');
    });
  });
});
