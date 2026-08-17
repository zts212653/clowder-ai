/**
 * F118 post-close regression: slot age is a reaper candidate signal, never a read-side terminal action.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const SHORT_TTL = 1000;
const T0 = 100_000;

describe('InvocationTracker owner lease reads (F118)', () => {
  it('keeps an execution older than the lease threshold visible without aborting it', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const controller = tracker.start('thread-live', 'codex-sol', 'user-1', ['codex-sol'], 'exec-live');

    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(tracker.has('thread-live', 'codex-sol'), true);
    assert.equal(tracker.has('thread-live'), true);
    assert.equal(tracker.getExecutionId('thread-live', 'codex-sol'), 'exec-live');
    assert.equal(tracker.getController('thread-live', 'codex-sol'), controller);
    assert.deepEqual(tracker.getActiveSlots('thread-live'), [{ catId: 'codex-sol', startedAt: T0 }]);
    assert.equal(controller.signal.aborted, false, 'a liveness read must never terminate provider work');
  });

  it('reports stale owner leases without mutating them', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('thread-old', 'codex-sol', 'user-1', ['codex-sol'], 'exec-old');
    t.mock.timers.tick(SHORT_TTL + 1);
    tracker.start('thread-fresh', 'codex-sol', 'user-1', ['codex-sol'], 'exec-fresh');

    assert.deepEqual(tracker.listStaleSlots(), [
      {
        threadId: 'thread-old',
        catId: 'codex-sol',
        userId: 'user-1',
        executionId: 'exec-old',
        startedAt: T0,
        ageMs: SHORT_TTL + 1,
        state: 'active',
      },
    ]);
    assert.equal(tracker.has('thread-old', 'codex-sol'), true, 'candidate enumeration must be observational');
    assert.equal(tracker.has('thread-fresh', 'codex-sol'), true);
  });

  it('retains manual-cancel-only leases until an exact terminal owner releases them', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: 0 });
    tracker.startAll('thread-manual', ['opus', 'codex-sol'], 'user-1', 'exec-manual');

    t.mock.timers.tick(24 * 60 * 60 * 1000);

    assert.deepEqual(tracker.listStaleSlots(), []);
    assert.deepEqual(
      tracker
        .getActiveSlots('thread-manual')
        .map((slot) => slot.catId)
        .sort(),
      ['codex-sol', 'opus'],
    );
  });
});
