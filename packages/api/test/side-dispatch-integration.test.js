/**
 * F108 Phase A Integration Tests — Side-Dispatch
 *
 * Tests cross-module interactions that verify AC-A1~A9:
 * - InvocationTracker + QueueProcessor (concurrent slots)
 * - WorklistRegistry (parentInvocationId isolation)
 * - AgentMessage invocationId tagging
 *
 * These are NOT redundant with unit tests — they test the *seams*
 * between modules that unit tests mock away.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { registerWorklist, unregisterWorklist, pushToWorklist, getWorklist } = await import(
  '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
);

// ── Helpers ──

function stubDeps(overrides = {}) {
  const tracker = new InvocationTracker();
  return {
    queue: new InvocationQueue(),
    invocationTracker: tracker,
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
      markDelivered: mock.fn(async () => true),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
  };
}

function enqueueEntry(queue, overrides = {}) {
  const entry = {
    threadId: 't1',
    userId: 'u1',
    content: 'hello',
    targetCats: ['opus'],
    intent: 'execute',
    source: 'user',
    ...overrides,
  };
  return queue.enqueue(entry);
}

// ── AC-A1: Concurrent different-cat invocations in same thread ──

describe('AC-A1: concurrent different-cat invocations (InvocationTracker + QueueProcessor)', () => {
  it('tracker allows two different cats concurrently; QueueProcessor slot mutex is independent', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    // Start opus via tracker directly
    const ctrl1 = deps.invocationTracker.start('t1', 'opus', 'u1', ['opus']);
    // Start codex via tracker directly
    const ctrl2 = deps.invocationTracker.start('t1', 'codex', 'u1', ['codex']);

    // Neither should be aborted
    assert.equal(ctrl1.signal.aborted, false, 'opus alive');
    assert.equal(ctrl2.signal.aborted, false, 'codex alive');

    // Both slots active
    assert.equal(deps.invocationTracker.has('t1', 'opus'), true);
    assert.equal(deps.invocationTracker.has('t1', 'codex'), true);

    // QueueProcessor: completing opus slot doesn't pause codex slot
    // Enqueue codex entry ONLY — opus has nothing queued
    enqueueEntry(deps.queue, { targetCats: ['codex'] });
    await processor.onInvocationComplete('t1', 'opus', 'canceled');
    // opus slot gets paused (canceled + queue has entries for thread)
    // but this is expected — the key test is codex is NOT paused
    assert.equal(processor.isPaused('t1', 'codex'), false, 'codex not paused by opus cancel');
  });
});

// ── AC-A3: Same cat serialization ──

describe('AC-A3: same cat same thread serializes (tracker → QueueProcessor)', () => {
  it('tracker aborts previous invocation for same cat', () => {
    const tracker = new InvocationTracker();
    const ctrl1 = tracker.start('t1', 'opus', 'u1', ['opus']);
    const ctrl2 = tracker.start('t1', 'opus', 'u1', ['opus']);
    assert.equal(ctrl1.signal.aborted, true, 'previous opus aborted');
    assert.equal(ctrl2.signal.aborted, false, 'new opus alive');
  });

  it('QueueProcessor same-cat entries serialize (mutex blocks second entry)', async () => {
    let resolveExecution;
    const slowDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          await new Promise((r) => {
            resolveExecution = r;
          });
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const processor = new QueueProcessor(slowDeps);

    // Two opus entries
    const e1 = enqueueEntry(slowDeps.queue, { content: 'first opus', targetCats: ['opus'] });
    slowDeps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-1');
    const e2 = enqueueEntry(slowDeps.queue, { content: 'second opus', targetCats: ['opus'] });
    slowDeps.queue.backfillMessageId('t1', 'u1', e2.id, 'msg-2');

    // Start first
    const r1 = await processor.processNext('t1', 'u1');
    assert.equal(r1.started, true, 'first opus starts');

    // Second should be blocked by mutex (same slot)
    const r2 = await processor.processNext('t1', 'u1');
    assert.equal(r2.started, false, 'second opus blocked by same-slot mutex');

    // Cleanup
    resolveExecution?.();
  });
});

// ── AC-A5: Backward compatibility ──

describe('AC-A5: backward compatibility — single-cat execution unchanged', () => {
  it('single cat execute-then-complete cycle works', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    // Start
    const ctrl = deps.invocationTracker.start('t1', 'opus', 'u1', ['opus']);
    assert.equal(deps.invocationTracker.has('t1'), true);

    // Complete
    deps.invocationTracker.complete('t1', 'opus', ctrl);
    assert.equal(deps.invocationTracker.has('t1', 'opus'), false);

    // Queue auto-dequeue still works
    enqueueEntry(deps.queue, { targetCats: ['opus'] });
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    // Should have auto-dequeued (no queued entries left with stub router)
  });

  it('cancel with userId auth still works per-slot', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'alice', ['opus']);
    const result = tracker.cancel('t1', 'opus', 'bob');
    assert.equal(result.cancelled, false, 'wrong userId rejected');
    assert.equal(tracker.has('t1', 'opus'), true);
  });
});

// ── AC-A6: WorklistRegistry parentInvocationId isolation ──

describe('AC-A6: WorklistRegistry parentInvocationId isolation', () => {
  afterEach(() => {
    // Cleanup all registries
    unregisterWorklist('t1', undefined, 'inv-opus-1');
    unregisterWorklist('t1', undefined, 'inv-codex-1');
    unregisterWorklist('t1');
  });

  it('two invocations in same thread have isolated worklists', () => {
    // Register worklists for two invocations: opus and codex
    const entry1 = registerWorklist('t1', ['opus'], 3, 'inv-opus-1');
    const entry2 = registerWorklist('t1', ['codex'], 3, 'inv-codex-1');

    // Push to opus worklist (callerCatId='opus' matches entry1.list[0])
    pushToWorklist('t1', ['gemini'], 'opus', 'inv-opus-1');

    // Opus worklist has the pushed cat
    const w1 = getWorklist('t1', 'inv-opus-1');
    assert.equal(w1?.list.length, 2); // ['opus', 'gemini']
    assert.ok(w1?.list.includes('gemini'), 'gemini pushed to opus worklist');

    // Codex worklist is separate
    const w2 = getWorklist('t1', 'inv-codex-1');
    assert.equal(w2?.list.length, 1, 'codex worklist untouched');
    assert.ok(!w2?.list.includes('gemini'), 'gemini not in codex worklist');
  });

  it('fallback to threadId key when no parentInvocationId', () => {
    const entry = registerWorklist('t1', ['opus'], 3);
    pushToWorklist('t1', ['codex'], 'opus');
    const w = getWorklist('t1');
    assert.equal(w?.list.length, 2); // ['opus', 'codex']
    assert.ok(w?.list.includes('codex'));
  });
});

// ── AC-A7: QueueProcessor slot-aware dequeue ──

describe('AC-A7: QueueProcessor slot-aware — opus completion dequeues only opus entries', () => {
  it('completing one slot auto-dequeues entries for that slot', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    // Enqueue entries for both cats
    enqueueEntry(deps.queue, { content: 'opus follow-up', targetCats: ['opus'] });
    enqueueEntry(deps.queue, { content: 'codex work', targetCats: ['codex'] });

    // Complete opus → should try to auto-dequeue
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    // Verify router was called (auto-dequeued an entry)
    assert.ok(deps.router.routeExecution.mock.calls.length > 0, 'auto-dequeue triggered execution');
  });
});

// ── AC-A8: AgentMessage carries invocationId ──

describe('AC-A8: QueueProcessor broadcasts carry invocationId', () => {
  it('executeEntry tags broadcast messages with invocationId', async () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    // Enqueue and process
    const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    await processor.processNext('t1', 'u1');

    // Wait for async execution
    await new Promise((r) => setTimeout(r, 50));

    // Check broadcast calls include invocationId
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    const msgsWithInvocationId = broadcastCalls.filter((c) => c.arguments[0]?.invocationId);
    assert.ok(msgsWithInvocationId.length > 0, 'at least one broadcast should carry invocationId');
  });
});

// ── AC-A9: MultiMention uses SlotTracker (InvocationTracker) ──

describe('AC-A9: InvocationTracker used as unified SlotTracker', () => {
  it('multi-mention scenario: main + side cats tracked independently', () => {
    const tracker = new InvocationTracker();

    // Main invocation targets opus
    const mainCtrl = tracker.start('t1', 'opus', 'u1', ['opus']);

    // Side-dispatch: multi_mention triggers codex
    const sideCtrl = tracker.start('t1', 'codex', 'u1', ['codex']);

    // Both alive
    assert.equal(mainCtrl.signal.aborted, false);
    assert.equal(sideCtrl.signal.aborted, false);

    // Active slots lists both
    const slots = tracker.getActiveSlots('t1');
    assert.deepEqual(slots.sort(), ['codex', 'opus']);

    // Cancel main → side survives
    tracker.cancel('t1', 'opus', 'u1');
    assert.equal(sideCtrl.signal.aborted, false, 'codex side-dispatch survives opus cancel');
    assert.equal(tracker.has('t1', 'codex'), true);

    // Cleanup
    tracker.cancel('t1', 'codex', 'u1');
  });

  it('delivery mode uses slot-specific has() — idle target cat gets immediate even when other cat active (P1-1)', () => {
    // Scenario: opus is active in thread, user sends message targeting codex.
    // Bug: thread-level has(threadId) returns true → queues the message.
    // Expected: slot-level has(threadId, 'codex') returns false → immediate delivery.
    const tracker = new InvocationTracker();

    // Start opus
    tracker.start('t1', 'opus', 'u1', ['opus']);

    // Thread-level check (old behavior) — would incorrectly queue
    assert.equal(tracker.has('t1'), true, 'thread-level has() sees opus active');

    // Slot-level check (correct behavior) — codex is idle
    assert.equal(tracker.has('t1', 'codex'), false, 'slot-level has() sees codex idle');
    assert.equal(tracker.has('t1', 'opus'), true, 'slot-level has() sees opus active');

    // Cleanup
    tracker.cancel('t1', 'opus', 'u1');
  });
});
