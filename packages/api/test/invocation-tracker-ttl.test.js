/**
 * F118 D3: InvocationTracker TTL Guard
 *
 * AC-D6: has() returns false and auto-deletes slots exceeding an enabled TTL
 * AC-D7: Long tool calls within TTL are NOT cleaned up (regression guard)
 * AC-D7b: Multi-cat — TTL sweep only clears the expired slot, not sibling cat slots
 * AC-D8: TTL=0 means disabled (manual-cancel-only), never immediate expiry
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const SHORT_TTL = 1000; // 1s for testing
const DEFAULT_SLOT_TTL = 75 * 60_000;
const T0 = 100_000; // arbitrary start time

describe('InvocationTracker TTL Guard (F118 D3)', () => {
  it('keeps the default slot alive for 75 minutes when CLI auto-timeout is disabled', (t) => {
    const savedTimeout = process.env.CLI_TIMEOUT_MS;
    process.env.CLI_TIMEOUT_MS = '0';
    t.after(() => {
      if (savedTimeout === undefined) delete process.env.CLI_TIMEOUT_MS;
      else process.env.CLI_TIMEOUT_MS = savedTimeout;
    });
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker();
    tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(1);
    assert.equal(tracker.has('t1', 'opus'), true, 'disabled CLI timeout must not collapse slot TTL to zero');

    t.mock.timers.tick(DEFAULT_SLOT_TTL);
    assert.equal(tracker.has('t1', 'opus'), false, 'independent 75-minute zombie guard must still expire the slot');
  });

  it('keeps slots active when TTL=0 disables automatic expiry', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: 0 });
    tracker.startAll('t1', ['opus', 'codex'], 'user1');

    t.mock.timers.tick(24 * 60 * 60 * 1000);
    assert.deepEqual(
      tracker
        .getActiveSlots('t1')
        .map((slot) => slot.catId)
        .sort(),
      ['codex', 'opus'],
      'manual-cancel-only mode must retain slots until explicit terminal cleanup',
    );
  });

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

  it('aborts an expired slot before removing it so provider cleanup can run', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const controller = tracker.start('t1', 'codex', 'user1', ['codex'], 'exec-1');
    let ownedDuringAbort = false;
    controller.signal.addEventListener('abort', () => {
      ownedDuringAbort = tracker.classifyExecutionId('t1', 'codex', 'exec-1') === 'matching';
    });

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(tracker.has('t1', 'codex'), false, 'expired slot should no longer be active');
    assert.equal(controller.signal.aborted, true, 'TTL expiry must abort the provider signal');
    assert.equal(controller.signal.reason, 'invocation_slot_ttl_expired');
    assert.equal(ownedDuringAbort, true, 'abort listeners must run while the expired invocation still owns the slot');
  });

  it('does not delete a replacement installed synchronously by an expiry abort listener', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const expiredController = tracker.start('t1', 'codex', 'user1');
    let replacementController;
    expiredController.signal.addEventListener('abort', () => {
      replacementController = tracker.start('t1', 'codex', 'user1');
    });

    t.mock.timers.tick(SHORT_TTL + 1);
    tracker.has('t1', 'codex'); // triggers expiry cleanup

    assert.ok(replacementController, 'abort listener should install the replacement');
    assert.equal(tracker.getController('t1', 'codex'), replacementController);
    assert.equal(tracker.has('t1', 'codex'), true, 'fresh replacement must remain active');
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
