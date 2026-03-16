/**
 * Unit tests for WorklistRegistry (F27)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('WorklistRegistry', () => {
  let _registryModule;

  // Import fresh each time to avoid cross-test contamination
  // (registry is a module-level Map)
  test('register + push + unregister lifecycle', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist, hasWorklist, getWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'test-lifecycle';
    const worklist = ['opus'];

    // Before register
    assert.equal(hasWorklist(threadId), false);
    assert.deepEqual(pushToWorklist(threadId, ['codex']).added, []);

    // Register
    const entry = registerWorklist(threadId, worklist, 10);
    assert.equal(hasWorklist(threadId), true);
    assert.equal(entry.a2aCount, 0);
    assert.equal(entry.maxDepth, 10);
    assert.strictEqual(entry.list, worklist);

    // Push unique
    const pushed = pushToWorklist(threadId, ['codex']);
    assert.deepEqual(pushed.added, ['codex']);
    assert.deepEqual(worklist, ['opus', 'codex']);
    assert.equal(entry.a2aCount, 1);

    // Push duplicate — no-op
    const pushDup = pushToWorklist(threadId, ['codex']);
    assert.deepEqual(pushDup.added, []);
    assert.deepEqual(worklist, ['opus', 'codex']);
    assert.equal(entry.a2aCount, 1);

    // Push multiple
    const pushMulti = pushToWorklist(threadId, ['gemini', 'codex']);
    assert.deepEqual(pushMulti.added, ['gemini']); // codex deduplicated
    assert.deepEqual(worklist, ['opus', 'codex', 'gemini']);
    assert.equal(entry.a2aCount, 2);

    // Unregister with owner check
    unregisterWorklist(threadId, entry);
    assert.equal(hasWorklist(threadId), false);
    assert.deepEqual(pushToWorklist(threadId, ['opus']).added, []);
  });

  test('push respects maxDepth', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'test-depth';
    const worklist = ['opus'];
    registerWorklist(threadId, worklist, 2);

    try {
      // Push 1st (a2aCount: 0 → 1) — ok
      assert.deepEqual(pushToWorklist(threadId, ['codex']).added, ['codex']);
      // Push 2nd (a2aCount: 1 → 2) — ok
      assert.deepEqual(pushToWorklist(threadId, ['gemini']).added, ['gemini']);
      // Push 3rd (a2aCount: 2 >= maxDepth: 2) — blocked
      assert.deepEqual(pushToWorklist(threadId, ['opus']).added, []);
    } finally {
      unregisterWorklist(threadId);
    }
  });

  test('R1 P1-1: preempt race — old unregister does not delete new worklist', async () => {
    const { registerWorklist, unregisterWorklist, hasWorklist, pushToWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'test-preempt';

    // Old invocation registers its worklist
    const oldEntry = registerWorklist(threadId, ['opus'], 10);
    assert.equal(hasWorklist(threadId), true);

    // New invocation preempts: registers a new worklist for the same thread
    const newEntry = registerWorklist(threadId, ['codex'], 10);
    assert.equal(hasWorklist(threadId), true);
    assert.notStrictEqual(oldEntry, newEntry);

    // Old invocation's finally block tries to unregister with stale owner
    unregisterWorklist(threadId, oldEntry);

    // New invocation's worklist must still be alive
    assert.equal(hasWorklist(threadId), true, 'new worklist must survive old unregister');
    const pushed = pushToWorklist(threadId, ['gemini']);
    assert.deepEqual(pushed.added, ['gemini'], 'push to new worklist must still work');

    // Cleanup: new owner unregisters
    unregisterWorklist(threadId, newEntry);
    assert.equal(hasWorklist(threadId), false);
  });

  test('cloud Codex P1: stale callback caller rejected by callerCatId guard', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist, getWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'test-caller-guard';

    // New invocation registers worklist: opus executes first, then codex
    const entry = registerWorklist(threadId, ['opus', 'codex'], 10);

    try {
      // executedIndex = 0 → current cat is opus
      // A callback from opus (current cat) should be allowed
      assert.deepEqual(pushToWorklist(threadId, ['gemini'], 'opus').added, ['gemini']);
      assert.equal(entry.a2aCount, 1);

      // A callback from codex (not currently executing) should be rejected
      // This simulates a stale callback from a preempted invocation whose catId is codex
      assert.deepEqual(pushToWorklist(threadId, ['opus'], 'codex').added, []);
      assert.equal(entry.a2aCount, 1, 'stale caller must not increase a2aCount');

      // Advance executedIndex to 1 → now codex is current
      entry.executedIndex = 1;

      // Now codex's callback should be allowed
      assert.deepEqual(pushToWorklist(threadId, ['opus'], 'codex').added, ['opus']);
      assert.equal(entry.a2aCount, 2);

      // But opus callback should now be rejected (it's no longer current)
      assert.deepEqual(pushToWorklist(threadId, ['gemini'], 'opus').added, []);
      assert.equal(entry.a2aCount, 2, 'past caller must not increase a2aCount');

      // Without callerCatId (legacy path from routeSerial text detection), always allowed.
      // Use a cat not already in pending to avoid dedup: worklist is now
      // ['opus','codex','gemini','opus'] with executedIndex=1, pending=['codex','gemini','opus'].
      // Push 'codex' would be deduped, so we push a cat that's not in pending.
      // Actually at this point pending already includes codex/gemini/opus.
      // Register a fresh worklist to test legacy path cleanly.
      unregisterWorklist(threadId, entry);
      const fresh = registerWorklist(threadId, ['opus'], 10);
      assert.deepEqual(pushToWorklist(threadId, ['codex']).added, ['codex']);
      assert.equal(fresh.a2aCount, 1, 'legacy path without callerCatId must still work');
      unregisterWorklist(threadId, fresh);
      return; // Skip the finally block cleanup since we already cleaned up
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('P1: do not overwrite reply target for pending original cats', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist, getWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'test-original-target-reply';
    const entry = registerWorklist(threadId, ['opus', 'codex'], 10);

    try {
      // codex is an original pending target; mention should NOT set A2A sender mapping
      assert.deepEqual(pushToWorklist(threadId, ['codex'], 'opus').added, []);
      assert.equal(getWorklist(threadId).a2aFrom.get('codex'), undefined);

      // A2A-added pending targets may still refresh to latest sender before execution
      assert.deepEqual(pushToWorklist(threadId, ['gemini'], 'opus').added, ['gemini']);
      assert.equal(getWorklist(threadId).a2aFrom.get('gemini'), 'opus');

      entry.executedIndex = 1; // now codex is current, gemini still pending
      assert.deepEqual(pushToWorklist(threadId, ['gemini'], 'codex').added, []);
      assert.equal(getWorklist(threadId).a2aFrom.get('gemini'), 'codex');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  // F121 a2aTriggerMessageId tests → worklist-registry-f121.test.js (file size cap)

  test('multiple threads are independent', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist, getWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const wl1 = ['opus'];
    const wl2 = ['codex'];
    registerWorklist('t1', wl1, 10);
    registerWorklist('t2', wl2, 10);

    try {
      assert.deepEqual(pushToWorklist('t1', ['codex']).added, ['codex']);
      assert.deepEqual(pushToWorklist('t2', ['opus']).added, ['opus']);

      assert.deepEqual(wl1, ['opus', 'codex']);
      assert.deepEqual(wl2, ['codex', 'opus']);
      assert.equal(getWorklist('t1').a2aCount, 1);
      assert.equal(getWorklist('t2').a2aCount, 1);
    } finally {
      unregisterWorklist('t1');
      unregisterWorklist('t2');
    }
  });
});

// F122 PushResult tests moved to worklist-registry-f122.test.js (file size cap)

// --- F108: parentInvocationId-based isolation (AC-A6) ---

describe('WorklistRegistry: parentInvocationId isolation (F108)', () => {
  test('two concurrent invocations in same thread have independent worklists (AC-A6)', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist, hasWorklist, getWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'thread-concurrent';

    // Invocation 1: opus running, keyed by parentInvocationId 'inv-1'
    const wl1 = ['opus'];
    const entry1 = registerWorklist(threadId, wl1, 10, 'inv-1');

    // Invocation 2: codex running, keyed by parentInvocationId 'inv-2'
    const wl2 = ['codex'];
    const entry2 = registerWorklist(threadId, wl2, 10, 'inv-2');

    try {
      // Both worklists coexist
      assert.equal(hasWorklist(threadId), true, 'thread-level check: any worklist active');

      // Push to inv-1 worklist only
      const pushed1 = pushToWorklist(threadId, ['gemini'], undefined, 'inv-1');
      assert.deepEqual(pushed1.added, ['gemini'], 'push to inv-1 worklist');
      assert.deepEqual(wl1, ['opus', 'gemini']);
      assert.deepEqual(wl2, ['codex'], 'inv-2 worklist untouched');

      // Push to inv-2 worklist only
      const pushed2 = pushToWorklist(threadId, ['opus'], undefined, 'inv-2');
      assert.deepEqual(pushed2.added, ['opus'], 'push to inv-2 worklist');
      assert.deepEqual(wl2, ['codex', 'opus']);
      assert.deepEqual(wl1, ['opus', 'gemini'], 'inv-1 worklist untouched');

      // Unregister inv-1, inv-2 still alive
      unregisterWorklist(threadId, entry1, 'inv-1');
      assert.equal(hasWorklist(threadId), true, 'inv-2 still active');

      // Unregister inv-2, thread worklist gone
      unregisterWorklist(threadId, entry2, 'inv-2');
      assert.equal(hasWorklist(threadId), false, 'no worklists left');
    } finally {
      // Safety cleanup
      unregisterWorklist(threadId, entry1, 'inv-1');
      unregisterWorklist(threadId, entry2, 'inv-2');
    }
  });

  test('pushToWorklist without parentInvocationId falls back to threadId key (backward compat)', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist, hasWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'thread-legacy';
    const wl = ['opus'];

    // Register without parentInvocationId (legacy path)
    const entry = registerWorklist(threadId, wl, 10);

    try {
      assert.equal(hasWorklist(threadId), true);

      // Push without parentInvocationId (legacy path)
      const pushed = pushToWorklist(threadId, ['codex']);
      assert.deepEqual(pushed.added, ['codex']);
      assert.deepEqual(wl, ['opus', 'codex']);
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('getWorklist with parentInvocationId returns specific invocation worklist', async () => {
    const { registerWorklist, unregisterWorklist, getWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'thread-get-specific';
    const wl1 = ['opus'];
    const wl2 = ['codex'];
    const entry1 = registerWorklist(threadId, wl1, 10, 'inv-a');
    const entry2 = registerWorklist(threadId, wl2, 5, 'inv-b');

    try {
      const fetched1 = getWorklist(threadId, 'inv-a');
      assert.equal(fetched1.maxDepth, 10);
      assert.strictEqual(fetched1.list, wl1);

      const fetched2 = getWorklist(threadId, 'inv-b');
      assert.equal(fetched2.maxDepth, 5);
      assert.strictEqual(fetched2.list, wl2);
    } finally {
      unregisterWorklist(threadId, entry1, 'inv-a');
      unregisterWorklist(threadId, entry2, 'inv-b');
    }
  });
});
