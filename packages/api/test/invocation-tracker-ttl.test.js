/**
 * F118 D3: InvocationTracker TTL Guard
 *
 * AC-D6: has() returns false and auto-deletes slots exceeding TTL (default 75min)
 * AC-D7: Long tool calls within TTL are NOT cleaned up (regression guard)
 * AC-D7b: Multi-cat — TTL sweep only clears the expired slot, not sibling cat slots
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

const SHORT_TTL = 1000; // 1s for testing
const T0 = 100_000; // arbitrary start time

describe('InvocationTracker TTL Guard (F118 D3)', () => {
  // ── AC-D6: expired slot auto-cleanup ──

  it('has(threadId, catId) returns false for slot exceeding TTL', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'opus', 'user1');
    assert.ok(tracker.has('t1', 'opus'), 'slot should exist immediately');

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(tracker.has('t1', 'opus'), false, 'expired slot should return false');
  });

  it('has(threadId) thread-level check returns false when all slots expired', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(tracker.has('t1'), false, 'thread-level check should return false');
  });

  it('expired slot is deleted from internal map (not just hidden)', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    tracker.has('t1', 'opus'); // triggers cleanup
    assert.deepEqual(tracker.getActiveSlots('t1'), [], 'slot should be physically removed');
  });

  // ── AC-D7: long tool calls within TTL are safe ──

  it('has() returns true for slot within TTL (long tool call regression)', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(SHORT_TTL - 100);
    assert.ok(tracker.has('t1', 'opus'), 'slot within TTL should still be active');
    assert.ok(tracker.has('t1'), 'thread-level check within TTL should be active');
  });

  // ── AC-D7b: multi-cat isolation ──

  it('TTL sweep only clears expired slot, not sibling cat in same thread', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'catA', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    // catA now expired. Start catB at the advanced clock — its startedAt is fresh.
    tracker.start('t1', 'catB', 'user1');

    assert.equal(tracker.has('t1', 'catA'), false, 'catA should be expired');
    assert.ok(tracker.has('t1', 'catB'), 'catB should still be alive');
    assert.ok(tracker.has('t1'), 'thread-level should be true (catB alive)');
  });

  it('getActiveSlots excludes expired slots', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'catA', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    tracker.start('t1', 'catB', 'user1');

    const slots = tracker.getActiveSlots('t1');
    assert.equal(slots.length, 1, 'only catB should remain');
    assert.equal(slots[0].catId, 'catB');
  });
});
