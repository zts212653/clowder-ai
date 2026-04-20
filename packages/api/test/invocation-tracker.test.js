/**
 * InvocationTracker (SlotTracker) Tests
 *
 * F108 Phase A Task 1: per-thread-per-cat isolation
 * AC-A1: Two different cats in same thread can have concurrent invocations
 * AC-A3: Same cat in same thread still serializes (aborts previous)
 *
 * Also covers existing userId auth + catId tracking (updated to slot-aware API).
 */

import assert from 'node:assert/strict';
import { describe, it, it as test } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

// --- Existing behavior (updated to slot-aware API) ---

describe('InvocationTracker userId auth (slot-aware)', () => {
  it('start records userId and getUserId returns it', () => {
    const tracker = new InvocationTracker();
    tracker.start('thread-1', 'opus', 'alice', ['opus']);
    assert.equal(tracker.getUserId('thread-1', 'opus'), 'alice');
  });

  it('cancel with matching userId succeeds', () => {
    const tracker = new InvocationTracker();
    tracker.start('thread-1', 'opus', 'alice', ['opus']);
    const result = tracker.cancel('thread-1', 'opus', 'alice');
    assert.equal(result.cancelled, true);
    assert.equal(tracker.has('thread-1', 'opus'), false);
  });

  it('cancel with mismatched userId is rejected', () => {
    const tracker = new InvocationTracker();
    tracker.start('thread-1', 'opus', 'alice', ['opus']);
    const result = tracker.cancel('thread-1', 'opus', 'bob');
    assert.equal(result.cancelled, false);
    assert.equal(tracker.has('thread-1', 'opus'), true);
    assert.equal(tracker.getUserId('thread-1', 'opus'), 'alice');
  });

  it('cancel without requestUserId allows cancel (backward compat)', () => {
    const tracker = new InvocationTracker();
    tracker.start('thread-1', 'opus', 'alice', ['opus']);
    const result = tracker.cancel('thread-1', 'opus');
    assert.equal(result.cancelled, true);
    assert.equal(tracker.has('thread-1', 'opus'), false);
  });
});

describe('InvocationTracker catId tracking (slot-aware)', () => {
  it('start with catIds stores them, cancel returns them', () => {
    const tracker = new InvocationTracker();
    tracker.start('thread-1', 'opus', 'alice', ['opus', 'gemini']);
    const result = tracker.cancel('thread-1', 'opus', 'alice');
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.catIds, ['opus', 'gemini']);
  });

  it('start without catIds defaults to empty array', () => {
    const tracker = new InvocationTracker();
    tracker.start('thread-1', 'opus', 'alice');
    const result = tracker.cancel('thread-1', 'opus', 'alice');
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.catIds, []);
  });

  it('cancel non-existent slot returns empty catIds', () => {
    const tracker = new InvocationTracker();
    const result = tracker.cancel('thread-missing', 'opus');
    assert.equal(result.cancelled, false);
    assert.deepEqual(result.catIds, []);
  });

  it('same cat new start in same thread overwrites previous catIds', () => {
    const tracker = new InvocationTracker();
    tracker.start('thread-1', 'opus', 'alice', ['opus']);
    tracker.start('thread-1', 'opus', 'bob', ['gemini', 'codex']);
    const result = tracker.cancel('thread-1', 'opus', 'bob');
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.catIds, ['gemini', 'codex']);
  });
});

describe('InvocationTracker preempt reason', () => {
  test('start aborts previous invocation with reason "preempted"', () => {
    const tracker = new InvocationTracker();
    const first = tracker.start('thread-1', 'opus', 'alice', ['opus']);
    assert.equal(first.signal.aborted, false);

    // New invocation for same slot preempts the old one
    tracker.start('thread-1', 'opus', 'bob', ['opus']);
    assert.equal(first.signal.aborted, true);
    assert.equal(first.signal.reason, 'preempted');
  });

  test('manual cancel does NOT set preempted reason', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.start('thread-1', 'opus', 'alice', ['opus']);
    tracker.cancel('thread-1', 'opus', 'alice');
    assert.equal(controller.signal.aborted, true);
    // Manual cancel uses default abort reason (undefined), not 'preempted'
    assert.notEqual(controller.signal.reason, 'preempted');
  });

  test('cancel with explicit abortReason forwards it to abort signal', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.start('thread-1', 'opus', 'alice', ['opus']);
    const result = tracker.cancel('thread-1', 'opus', 'alice', 'preempted');
    assert.equal(result.cancelled, true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(controller.signal.reason, 'preempted');
  });
});

// --- New slot-aware behavior (F108 AC-A1, AC-A3) ---

describe('SlotTracker: per-thread-per-cat isolation', () => {
  it('two different cats in same thread can have concurrent invocations (AC-A1)', () => {
    const tracker = new InvocationTracker();
    const ctrl1 = tracker.start('t1', 'opus', 'user1', ['opus']);
    const ctrl2 = tracker.start('t1', 'codex', 'user1', ['codex']);
    assert.equal(ctrl1.signal.aborted, false, 'opus should NOT be aborted');
    assert.equal(ctrl2.signal.aborted, false, 'codex should NOT be aborted');
    assert.equal(tracker.has('t1', 'opus'), true);
    assert.equal(tracker.has('t1', 'codex'), true);
    assert.equal(tracker.has('t1'), true, 'thread-level has() with any slot active');
  });

  it('same cat in same thread aborts previous invocation (AC-A3)', () => {
    const tracker = new InvocationTracker();
    const ctrl1 = tracker.start('t1', 'opus', 'user1', ['opus']);
    const ctrl2 = tracker.start('t1', 'opus', 'user1', ['opus']);
    assert.equal(ctrl1.signal.aborted, true, 'old opus invocation aborted');
    assert.equal(ctrl2.signal.aborted, false, 'new opus invocation alive');
  });

  it('cancel targets specific slot only', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.start('t1', 'codex', 'user1', ['codex']);
    tracker.cancel('t1', 'opus');
    assert.equal(tracker.has('t1', 'opus'), false, 'opus cancelled');
    assert.equal(tracker.has('t1', 'codex'), true, 'codex survives');
  });

  it('cancelAll aborts all slots in thread', () => {
    const tracker = new InvocationTracker();
    const ctrl1 = tracker.start('t1', 'opus', 'user1', ['opus']);
    const ctrl2 = tracker.start('t1', 'codex', 'user1', ['codex']);
    tracker.cancelAll('t1');
    assert.equal(ctrl1.signal.aborted, true);
    assert.equal(ctrl2.signal.aborted, true);
    assert.equal(tracker.has('t1'), false, 'no slots remain');
  });

  it('getActiveSlots returns {catId, startedAt} for all active slots', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.start('t1', 'codex', 'user1', ['codex']);
    const slots = tracker.getActiveSlots('t1');
    const catIds = slots.map((s) => s.catId).sort();
    assert.deepEqual(catIds, ['codex', 'opus']);
    for (const slot of slots) {
      assert.equal(typeof slot.startedAt, 'number');
      assert.ok(slot.startedAt > 0, 'startedAt should be positive epoch ms');
    }
  });

  it('getActiveSlots returns empty for unknown thread', () => {
    const tracker = new InvocationTracker();
    assert.deepEqual(tracker.getActiveSlots('unknown'), []);
  });

  it('complete removes only matching slot', () => {
    const tracker = new InvocationTracker();
    const ctrl1 = tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.start('t1', 'codex', 'user1', ['codex']);
    tracker.complete('t1', 'opus', ctrl1);
    assert.equal(tracker.has('t1', 'opus'), false);
    assert.equal(tracker.has('t1', 'codex'), true);
  });

  it('complete with wrong controller does not remove slot', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    const wrongController = new AbortController();
    tracker.complete('t1', 'opus', wrongController);
    assert.equal(tracker.has('t1', 'opus'), true, 'slot survives wrong controller');
  });

  it('getUserId returns per-slot user', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'alice', ['opus']);
    tracker.start('t1', 'codex', 'bob', ['codex']);
    assert.equal(tracker.getUserId('t1', 'opus'), 'alice');
    assert.equal(tracker.getUserId('t1', 'codex'), 'bob');
  });

  it('has(threadId) without catId returns true if any slot active', () => {
    const tracker = new InvocationTracker();
    assert.equal(tracker.has('t1'), false);
    tracker.start('t1', 'opus', 'user1', ['opus']);
    assert.equal(tracker.has('t1'), true);
    tracker.cancel('t1', 'opus');
    assert.equal(tracker.has('t1'), false);
  });

  it('guardDelete blocks all slots and rejects new starts', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);

    // Cannot guard while slot active
    const guard1 = tracker.guardDelete('t1');
    assert.equal(guard1.acquired, false);

    // Cancel slot, then guard succeeds
    tracker.cancel('t1', 'opus');
    const guard2 = tracker.guardDelete('t1');
    assert.equal(guard2.acquired, true);

    // New start during guard returns pre-aborted controller
    const ctrl = tracker.start('t1', 'codex', 'user1', ['codex']);
    assert.equal(ctrl.signal.aborted, true, 'start during delete guard pre-aborts');

    guard2.release();
  });

  it('different threads are fully independent', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.start('t2', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');
    assert.equal(tracker.has('t1', 'opus'), false);
    assert.equal(tracker.has('t2', 'opus'), true);
  });

  it('getCatIds returns target cats for specific slot', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus', 'gemini']);
    tracker.start('t1', 'codex', 'user1', ['codex']);
    assert.deepEqual(tracker.getCatIds('t1', 'opus'), ['opus', 'gemini']);
    assert.deepEqual(tracker.getCatIds('t1', 'codex'), ['codex']);
  });

  // F122 Phase A.1: tryStartThread — non-preemptive thread-level busy gate
  it('tryStartThread returns null when another slot is active in same thread', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'catA', 'user1');
    const result = tracker.tryStartThread('t1', 'catB', 'user1');
    assert.equal(result, null, 'should return null when thread is busy');
    assert.equal(tracker.has('t1', 'catA'), true, 'catA slot should still be active');
  });

  it('tryStartThread succeeds when thread is idle', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.tryStartThread('t1', 'catA', 'user1', ['catA']);
    assert.ok(controller, 'should return AbortController when thread is idle');
    assert.equal(tracker.has('t1', 'catA'), true, 'slot should be registered');
  });

  it('tryStartThread returns null when thread is deleting', () => {
    const tracker = new InvocationTracker();
    const guard = tracker.guardDelete('t1');
    assert.equal(guard.acquired, true);
    const result = tracker.tryStartThread('t1', 'catA', 'user1');
    assert.equal(result, null, 'should return null when thread is deleting');
    guard.release();
  });
});

// --- Multi-cat startAll / completeAll / startedAt (Bug fix: concurrent multi-cat display) ---

describe('InvocationTracker: startAll registers all target cats', () => {
  it('startAll creates slots for all catIds with shared controller', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    assert.equal(tracker.has('t1', 'opus'), true);
    assert.equal(tracker.has('t1', 'codex'), true);
    // Both slots share the same controller
    assert.equal(controller.signal.aborted, false);
  });

  it('startAll preempts existing slots for same catId', () => {
    const tracker = new InvocationTracker();
    const old = tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.startAll('t1', ['opus', 'codex'], 'user1');
    assert.equal(old.signal.aborted, true, 'old opus slot should be preempted');
    assert.equal(old.signal.reason, 'preempted');
  });

  it('startAll returns pre-aborted controller when thread is deleting', () => {
    const tracker = new InvocationTracker();
    const guard = tracker.guardDelete('t1');
    assert.equal(guard.acquired, true);
    const controller = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    assert.equal(controller.signal.aborted, true);
    guard.release();
  });

  it('completeAll removes all target cat slots', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.startAll('t1', ['opus', 'codex', 'gemini'], 'user1');
    tracker.completeAll('t1', ['opus', 'codex', 'gemini'], controller);
    assert.equal(tracker.has('t1'), false, 'all slots removed');
  });

  it('completeAll matches all batch slots via batchController', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    // complete() with primaryController matches opus (its own controller)
    tracker.complete('t1', 'opus', controller);
    assert.equal(tracker.has('t1', 'opus'), false);
    assert.equal(tracker.has('t1', 'codex'), true);
    // complete() with primaryController does NOT match codex (different controller)
    // — this is correct: use completeAll for batch cleanup
    tracker.complete('t1', 'codex', controller);
    assert.equal(tracker.has('t1', 'codex'), true, 'individual complete should not match non-primary controller');
    // completeAll matches via batchController
    tracker.completeAll('t1', ['codex'], controller);
    assert.equal(tracker.has('t1'), false);
  });

  it('completeSlot releases one finished cat from a batch via batchController', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.startAll('t1', ['opus', 'codex'], 'user1');

    tracker.completeSlot('t1', 'opus', controller);

    assert.equal(tracker.has('t1', 'opus'), false, 'finished cat should be released immediately');
    assert.equal(tracker.has('t1', 'codex'), true, 'still-running cat must keep its slot');
  });

  it('completeSlot with wrong controller does not remove the slot', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1');

    tracker.completeSlot('t1', 'opus', new AbortController());

    assert.equal(tracker.has('t1', 'opus'), true);
    assert.equal(tracker.has('t1', 'codex'), true);
  });

  it('completeAll with wrong controller does not remove slots', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1');
    const wrongCtrl = new AbortController();
    tracker.completeAll('t1', ['opus', 'codex'], wrongCtrl);
    assert.equal(tracker.has('t1', 'opus'), true, 'opus should survive wrong controller');
    assert.equal(tracker.has('t1', 'codex'), true, 'codex should survive wrong controller');
  });
});

describe('InvocationTracker: tryStartThreadAll', () => {
  it('registers all cats when thread is idle', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.tryStartThreadAll('t1', ['opus', 'codex'], 'user1');
    assert.ok(controller, 'should return controller when idle');
    assert.equal(tracker.has('t1', 'opus'), true);
    assert.equal(tracker.has('t1', 'codex'), true);
  });

  it('returns null when thread has active slots', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'gemini', 'user1', ['gemini']);
    const result = tracker.tryStartThreadAll('t1', ['opus', 'codex'], 'user1');
    assert.equal(result, null);
    // gemini should still be active, opus/codex not registered
    assert.equal(tracker.has('t1', 'gemini'), true);
    assert.equal(tracker.has('t1', 'opus'), false);
    assert.equal(tracker.has('t1', 'codex'), false);
  });

  it('returns null when thread is deleting', () => {
    const tracker = new InvocationTracker();
    const guard = tracker.guardDelete('t1');
    const result = tracker.tryStartThreadAll('t1', ['opus', 'codex'], 'user1');
    assert.equal(result, null);
    guard.release();
  });
});

describe('InvocationTracker: per-cat cancel isolation (AC-B9 regression)', () => {
  it('cancel one cat from startAll batch does NOT abort other cats', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1');
    // Cancel opus only
    const result = tracker.cancel('t1', 'opus');
    assert.equal(result.cancelled, true);
    assert.equal(tracker.has('t1', 'opus'), false, 'opus should be removed');
    assert.equal(tracker.has('t1', 'codex'), true, 'codex must survive opus cancel');
    // Verify codex controller is NOT aborted
    const slots = tracker.getActiveSlots('t1');
    assert.equal(slots.length, 1);
    assert.equal(slots[0].catId, 'codex');
  });

  it('cancel non-primary cat does NOT abort primary execution signal', () => {
    const tracker = new InvocationTracker();
    const primaryController = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    // Cancel codex (non-primary)
    tracker.cancel('t1', 'codex');
    // Primary controller must NOT be aborted — routeExecution depends on it
    assert.equal(primaryController.signal.aborted, false, 'primary controller must survive non-primary cancel');
    assert.equal(tracker.has('t1', 'opus'), true, 'opus must survive codex cancel');
  });

  it('cancel primary cat aborts only primary controller', () => {
    const tracker = new InvocationTracker();
    const primaryController = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    // Cancel opus (primary)
    tracker.cancel('t1', 'opus');
    assert.equal(primaryController.signal.aborted, true, 'primary controller should be aborted');
    // Codex's own controller should NOT be aborted
    assert.equal(tracker.has('t1', 'codex'), true, 'codex slot still exists');
  });

  it('tryStartThreadAll also creates independent controllers', () => {
    const tracker = new InvocationTracker();
    const primaryController = tracker.tryStartThreadAll('t1', ['opus', 'codex'], 'user1');
    assert.ok(primaryController);
    tracker.cancel('t1', 'codex');
    assert.equal(primaryController.signal.aborted, false, 'primary survives non-primary cancel');
    assert.equal(tracker.has('t1', 'opus'), true);
  });
});

// F156 Phase B-2: cancelAll with userId authorization
describe('InvocationTracker: cancelAll userId guard (F156 B-2)', () => {
  it('cancelAll with matching userId only cancels that user invocations', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'alice', ['opus']);
    tracker.start('t1', 'codex', 'bob', ['codex']);
    tracker.cancelAll('t1', 'alice');
    assert.equal(tracker.has('t1', 'opus'), false, 'alice opus should be cancelled');
    assert.equal(tracker.has('t1', 'codex'), true, 'bob codex should survive');
  });

  it('cancelAll without userId cancels all (backward compat / admin)', () => {
    const tracker = new InvocationTracker();
    const ctrl1 = tracker.start('t1', 'opus', 'alice', ['opus']);
    const ctrl2 = tracker.start('t1', 'codex', 'bob', ['codex']);
    tracker.cancelAll('t1');
    assert.equal(ctrl1.signal.aborted, true);
    assert.equal(ctrl2.signal.aborted, true);
    assert.equal(tracker.has('t1'), false);
  });

  it('cancelAll returns cancelled catIds for orchestrator scoping', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'alice', ['opus']);
    tracker.start('t1', 'codex', 'bob', ['codex']);
    tracker.start('t1', 'gemini', 'alice', ['gemini']);

    const cancelled = tracker.cancelAll('t1', 'alice');
    assert.ok(Array.isArray(cancelled), 'cancelAll must return an array');
    assert.deepStrictEqual(cancelled.sort(), ['gemini', 'opus'], 'should return only alice catIds');
    assert.equal(tracker.has('t1', 'codex'), true, 'bob codex untouched');
  });

  it('cancelAll without userId returns all cancelled catIds', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'alice', ['opus']);
    tracker.start('t1', 'codex', 'bob', ['codex']);

    const cancelled = tracker.cancelAll('t1');
    assert.ok(Array.isArray(cancelled), 'cancelAll must return an array');
    assert.deepStrictEqual(cancelled.sort(), ['codex', 'opus']);
  });
});

describe('InvocationTracker: startedAt timestamp', () => {
  it('start() sets startedAt and getActiveSlots returns it', () => {
    const before = Date.now();
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    const after = Date.now();
    const slots = tracker.getActiveSlots('t1');
    assert.equal(slots.length, 1);
    assert.ok(slots[0].startedAt >= before, `startedAt (${slots[0].startedAt}) >= before (${before})`);
    assert.ok(slots[0].startedAt <= after, `startedAt (${slots[0].startedAt}) <= after (${after})`);
  });

  it('startAll() sets same startedAt for all cats', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1');
    const slots = tracker.getActiveSlots('t1');
    assert.equal(slots.length, 2);
    // All cats should share the same startedAt (same Date.now() call)
    assert.equal(slots[0].startedAt, slots[1].startedAt, 'startAll should use single timestamp');
  });

  it('F5 recovery: getActiveSlots preserves original startedAt after time passes', async () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1');
    const slotsEarly = tracker.getActiveSlots('t1');
    // Simulate time passing (F5 happens later)
    await new Promise((r) => setTimeout(r, 50));
    const slotsLater = tracker.getActiveSlots('t1');
    // startedAt should be the ORIGINAL time, not Date.now() at query time
    assert.equal(slotsLater[0].startedAt, slotsEarly[0].startedAt, 'startedAt must not change over time');
  });
});
