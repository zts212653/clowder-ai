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
  it('rejects queued batch admission while a seal guard is held and wakes after release', async () => {
    const tracker = new InvocationTracker();
    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, true);

    const blocked = tracker.startAll('t1', ['opus'], 'user1', 'inv-blocked');
    assert.equal(blocked, null, 'seal contention must be explicit non-admission, not an aborted owner');

    let released = false;
    const wait = tracker.waitForSessionSealRelease('t1', ['opus']).then(() => {
      released = true;
    });
    await Promise.resolve();
    assert.equal(released, false, 'queue retry must stay parked while the CAS guard is held');

    guard.release();
    await wait;
    assert.equal(released, true);
    const admitted = tracker.startAll('t1', ['opus'], 'user1', 'inv-admitted');
    assert.ok(admitted);
    assert.equal(admitted.signal.aborted, false);
  });

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

  it('guardSessionSeal stays blocked after a per-event completeSlot(); route-terminal completeAll unblocks', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    tracker.cancel('t1', 'opus');

    // A canceled slot can emit a per-cat 'error' event while the stream still has
    // trailing events and route-finally persistence pending — the per-event
    // completeSlot() must NOT prove teardown finished.
    tracker.completeSlot('t1', 'opus', batch);
    const early = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(early.acquired, false, 'per-event completeSlot must not unblock the seal fence');

    // The route's terminal completion (finally) is the teardown-complete proof.
    tracker.completeAll('t1', ['opus', 'codex'], batch);
    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, true, 'seal allowed after route-terminal completeAll');
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

  it('expired tombstone still blocks seal; the reaper sees it instead (F118 post-close)', () => {
    const tracker = new InvocationTracker({ maxSlotTtlMs: 1 });
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancel('t1', 'opus');

    // Spin until the 1ms TTL expires
    const deadline = Date.now() + 10;
    while (Date.now() < deadline) {
      /* wait for expiry */
    }

    // Age alone never clears a pending teardown on the read path.
    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, false, 'age alone must not clear a pending teardown');

    // The stuck tombstone stays visible to the explicit liveness reaper.
    const stale = tracker.listStaleSlots();
    assert.equal(stale.length, 1);
    assert.equal(stale[0].state, 'canceled');
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

  it('guardDelete intentionally allows a tombstone with pending teardown', () => {
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

// ── cancelAll (force-reset / Stop-all) → Seal race ──
// Terra P1 review: Stop button fires POST /api/threads/:id/force-reset → cancelAll.
// cancelAll deleted slots outright, so guardSessionSeal saw them as idle while
// the provider route was still tearing down.

describe('InvocationTracker: cancelAll → Seal race (#1313 P1)', () => {
  it('guardSessionSeal rejects immediately after cancelAll (teardown pending)', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1');
    tracker.cancelAll('t1');

    // has() must still be false (queue gates unaffected)
    assert.equal(tracker.has('t1', 'opus'), false);
    assert.equal(tracker.has('t1', 'codex'), false);
    assert.equal(tracker.has('t1'), false);

    // But seal must block for EACH cat
    const g1 = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(g1.acquired, false, 'opus seal must wait for teardown');

    const g2 = tracker.guardSessionSeal('t1', 'codex');
    assert.equal(g2.acquired, false, 'codex seal must wait for teardown');
  });

  it('guardSessionSeal succeeds after completeAll marks cancelAll teardown done', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    tracker.cancelAll('t1');

    // Simulate route teardown finishing
    tracker.completeAll('t1', ['opus', 'codex'], batch);

    const g1 = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(g1.acquired, true, 'opus seal allowed after teardown');
    g1.release();

    const g2 = tracker.guardSessionSeal('t1', 'codex');
    assert.equal(g2.acquired, true, 'codex seal allowed after teardown');
    g2.release();
  });

  it('guardSessionSeal succeeds after per-cat complete marks cancelAll teardown done', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancelAll('t1');

    // Route cleanup calls complete per-cat (no controller for cancelAll path)
    tracker.complete('t1', 'opus');

    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, true, 'seal allowed after per-cat complete');
    guard.release();
  });

  it('cancelAll with userId filter only tombstones matching user slots', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'alice', ['opus']);
    tracker.start('t1', 'codex', 'bob', ['codex']);
    tracker.cancelAll('t1', 'alice');

    // alice's opus is tombstoned — seal blocked
    assert.equal(tracker.has('t1', 'opus'), false);
    const g1 = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(g1.acquired, false, 'alice slot tombstoned — seal blocked');

    // bob's codex is still active — seal also blocked (active, not tombstone)
    assert.equal(tracker.has('t1', 'codex'), true);
    const g2 = tracker.guardSessionSeal('t1', 'codex');
    assert.equal(g2.acquired, false, 'bob slot still active — seal blocked');
  });

  it('cancelAll tombstone does not block new start (queue gates intact)', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancelAll('t1');

    // has() returns false → tryStartThread succeeds
    const ctrl = tracker.tryStartThread('t1', 'codex', 'user1', ['codex']);
    assert.ok(ctrl, 'new start must succeed — cancelAll tombstone is invisible to has()');
    assert.equal(ctrl.signal.aborted, false);
  });

  it('does not report an already-canceled tombstone as a new cancelAll result', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.startAll('t1', ['opus'], 'user1', 'inv-canceled');
    assert.ok(controller);
    assert.deepEqual(tracker.cancelAll('t1').catIds, ['opus']);
    tracker.completeAll('t1', ['opus'], controller);

    const repeated = tracker.cancelAll('t1');

    assert.deepEqual(repeated.catIds, []);
    assert.deepEqual(repeated.executionIds, []);
    assert.deepEqual(repeated.executionIdByCatId, {});
    assert.equal(tracker.getSlotState('t1', 'opus'), 'canceled', 'completed tombstone remains observable');
  });

  it('cancelAll preserves batch final status via batch.aborted (not tombstone)', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    tracker.cancelAll('t1', undefined, 'cancel_all');

    // cancelAll aborts the batch gate — resolveFinalStatus uses batch.aborted (first branch)
    assert.equal(batch.signal.aborted, true, 'batch gate must be aborted');
    const status = tracker.resolveFinalStatus('t1', ['opus', 'codex'], {
      aborted: batch.signal.aborted,
      reason: 'cancel_all',
    });
    assert.equal(status, 'canceled_by_user');
  });

  it('expired cancelAll tombstone still blocks seal; the reaper sees it instead (F118 post-close)', () => {
    const tracker = new InvocationTracker({ maxSlotTtlMs: 1 });
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancelAll('t1');

    const deadline = Date.now() + 10;
    while (Date.now() < deadline) {
      /* wait for expiry */
    }

    // Age alone never clears a pending teardown on the read path.
    const guard = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(guard.acquired, false, 'age alone must not clear a pending teardown');

    // The stuck tombstone stays visible to the explicit liveness reaper.
    const stale = tracker.listStaleSlots();
    assert.equal(stale.length, 1);
    assert.equal(stale[0].state, 'canceled');
  });

  it('getActiveSlots returns empty after cancelAll (tombstones excluded)', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1');
    tracker.cancelAll('t1');

    assert.deepEqual(tracker.getActiveSlots('t1'), []);
  });

  it('classifyExecutionId reports canceled tombstones as absent (ownership is over)', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1', 'inv-late');
    assert.equal(tracker.classifyExecutionId('t1', 'codex', 'inv-late'), 'matching');

    tracker.cancelAll('t1');

    // Force replacement / late terminal cleanup must not inherit the dead
    // execution, and completeByExecutionId must not delete the teardown fence.
    assert.equal(tracker.classifyExecutionId('t1', 'codex', 'inv-late'), 'absent');
    assert.equal(tracker.completeByExecutionId('t1', 'codex', 'inv-late'), 'absent');
    const guard = tracker.guardSessionSeal('t1', 'codex');
    assert.equal(guard.acquired, false, 'teardown fence must survive execution-id cleanup');
  });

  it('lets only the independently-proven terminal release path reap an exact canceled tombstone', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['codex'], 'user1', 'inv-zombie');
    tracker.cancelAll('t1');

    assert.equal(tracker.completeByExecutionId('t1', 'codex', 'inv-zombie'), 'absent');
    assert.equal(tracker.releaseTerminalByExecutionId('t1', 'codex', 'inv-other'), 'replacement');
    assert.equal(tracker.guardSessionSeal('t1', 'codex').acquired, false);

    assert.equal(tracker.releaseTerminalByExecutionId('t1', 'codex', 'inv-zombie'), 'released');
    const guard = tracker.guardSessionSeal('t1', 'codex');
    assert.equal(guard.acquired, true, 'independent terminal proof may release the stale fence');
    guard.release();
  });

  it('startAll replaces cancelAll tombstones and runs normally', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus'], 'user1');
    tracker.cancelAll('t1');

    // New startAll should replace the tombstone
    const batch = tracker.startAll('t1', ['opus'], 'user1');
    assert.equal(batch.signal.aborted, false, 'new batch gate is fresh');
    assert.equal(tracker.has('t1', 'opus'), true);
    assert.equal(tracker.getSlotState('t1', 'opus'), 'active');
  });
});

// ── scoped force/preempt → Seal race ──
// #1313 P1 follow-up: callback-a2a-trigger uses cancelInvocation() for an
// in-flight force delivery. It must preserve the same teardown fence as the
// visible Stop path without canceling an unrelated side-dispatch.

describe('InvocationTracker: cancelInvocation → Seal race (#1313 P1 follow-up)', () => {
  it('blocks seal for every canceled batch sibling until scoped preempt teardown completes', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('t1', ['opus', 'codex'], 'user1');

    const cancelled = tracker.cancelInvocation('t1', ['opus'], 'user1', 'preempted');

    assert.deepEqual(cancelled.sort(), ['codex', 'opus']);
    assert.equal(tracker.has('t1', 'opus'), false);
    assert.equal(tracker.has('t1', 'codex'), false);
    assert.equal(tracker.guardSessionSeal('t1', 'opus').acquired, false, 'opus teardown is pending');
    assert.equal(tracker.guardSessionSeal('t1', 'codex').acquired, false, 'codex teardown is pending');

    tracker.completeAll('t1', ['opus', 'codex'], batch);

    const opusSeal = tracker.guardSessionSeal('t1', 'opus');
    assert.equal(opusSeal.acquired, true, 'opus seal is safe after terminal cleanup');
    opusSeal.release();
    const codexSeal = tracker.guardSessionSeal('t1', 'codex');
    assert.equal(codexSeal.acquired, true, 'codex seal is safe after terminal cleanup');
    codexSeal.release();
  });

  it('keeps an unrelated side-dispatch active while the preempted batch is tombstoned', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['codex'], 'user1');
    tracker.startAll('t1', ['opus'], 'user1');

    tracker.cancelInvocation('t1', ['codex'], 'user1', 'preempted');

    assert.equal(tracker.has('t1', 'codex'), false, 'preempted slot must not block replacement work');
    assert.equal(tracker.guardSessionSeal('t1', 'codex').acquired, false, 'preempted teardown still blocks seal');
    assert.equal(tracker.has('t1', 'opus'), true, 'unrelated side-dispatch remains active');
    assert.equal(tracker.guardSessionSeal('t1', 'opus').acquired, false, 'active side-dispatch remains protected');
  });

  it('allows an immediate replacement start while scoped-preempt teardown is pending', () => {
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1', ['opus']);
    tracker.cancelInvocation('t1', ['opus'], 'user1', 'preempted');

    const replacement = tracker.start('t1', 'opus', 'user1', ['opus']);

    assert.equal(replacement.signal.aborted, false);
    assert.equal(tracker.has('t1', 'opus'), true);
    assert.equal(tracker.getSlotState('t1', 'opus'), 'active');
  });
});
