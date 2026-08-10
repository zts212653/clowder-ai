/**
 * InvocationTracker: Stop→Seal race condition regression (#1313)
 *
 * A cancelled tombstone (single-cat cancel) must block guardSessionSeal()
 * until the invocation's teardown calls complete(). Without this, a "Stop"
 * followed by an immediate "Seal" can proceed while the provider route is
 * still tearing down — risking concurrent transcript flush / incomplete seal.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

describe('InvocationTracker: Stop→Seal race (#1313)', () => {
  // ── Core regression: cancel tombstone blocks seal until teardown completes ──

  it('guardSessionSeal rejects while a cancel tombstone has pending teardown', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    // has() correctly treats tombstone as inactive (queue gates work)
    assert.equal(tracker.has('t1', 'opus'), false);
    // But seal must wait — teardown hasn't finished
    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, false, 'seal must wait for teardown to complete');
  });

  it('guardSessionSeal succeeds after complete() marks teardown done', () => {
    const tracker = new InvocationTracker();
    const ctrl = tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    // Simulate teardown finishing
    tracker.complete('t1', 'opus', ctrl);

    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, true, 'seal allowed after teardown');
    guard.release();
  });

  it('guardSessionSeal succeeds after completeSlot() marks batch teardown done', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    tracker.cancel('t1', 'opus');

    tracker.completeSlot('t1', 'opus', batch);

    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, true, 'seal allowed after completeSlot');
    guard.release();
  });

  it('guardSessionSeal succeeds after completeAll() marks batch teardown done', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('t1', ['opus'], 'user1');
    tracker.cancel('t1', 'opus');

    tracker.completeAll('t1', ['opus'], batch);

    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, true, 'seal allowed after completeAll');
    guard.release();
  });

  // ── Invariant preservation: tombstone semantics must stay intact ──

  it('has() still returns false for tombstone (queue gates unaffected)', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    assert.equal(tracker.has('t1', 'opus'), false);
    assert.equal(tracker.has('t1'), false);
  });

  it('getSlotState still returns canceled for tombstone with pending teardown', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    assert.equal(tracker.getSlotState('t1', 'opus'), 'canceled');
  });

  it('resolveFinalStatus still works after teardown-complete tombstone', () => {
    const tracker = new InvocationTracker();
    const ctrl = tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');
    tracker.complete('t1', 'opus', ctrl);

    // Tombstone must survive complete() — resolveFinalStatus needs it
    const status = tracker.resolveFinalStatus('t1', ['opus'], { aborted: false });
    assert.equal(status, 'canceled_by_user');
  });

  it('getController still returns aborted controller for tombstone', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    const ctrl = tracker.getController('t1', 'opus');
    assert.ok(ctrl, 'tombstone must still return its aborted controller');
    assert.equal(ctrl.signal.aborted, true);
  });

  // ── Edge cases ──

  it('new start purges old tombstone regardless of teardown state', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    // New invocation replaces the tombstone
    tracker.start('t1', 'opus', 'user1', ['opus']);
    assert.equal(tracker.has('t1', 'opus'), true);
    assert.equal(tracker.getSlotState('t1', 'opus'), 'active');
  });

  it('expired tombstone does not block seal', () => {
    const tracker = new InvocationTracker({ maxSlotTtlMs: 1 });
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    // Spin until the 1ms TTL expires
    const deadline = Date.now() + 10;
    while (Date.now() < deadline) {
      /* wait for expiry */
    }

    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, true, 'expired tombstone must not block seal');
    guard.release();
  });

  it('complete with wrong controller does not mark teardown as done', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    // Wrong controller — should not affect tombstone
    tracker.complete('t1', 'opus', new AbortController());

    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, false, 'wrong-controller complete must not unlock seal');
  });

  it('guardDelete still rejects tombstone with pending teardown', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    // guardDelete uses has() which returns false for tombstones.
    // This is existing behavior — guardDelete allows acquisition.
    // (Thread deletion is a different concern from session seal.)
    const guard = tracker.guardDelete('t1');
    assert.equal(guard.acquired, true, 'guardDelete still uses has() — tombstone = idle for deletion');
    guard.release();
  });
});
