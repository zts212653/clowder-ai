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

  it('getActiveSlots returns all active catIds for thread', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.start('t1', 'codex', 'user1', ['codex']);
    const slots = tracker.getActiveSlots('t1');
    assert.deepEqual(slots.sort(), ['codex', 'opus']);
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
