/**
 * F122 Phase A.1: TOCTOU regression tests
 *
 * Validates that the tryStartThread busy gate and slot lifecycle
 * correctly prevent user messages from interrupting A2A chains.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

describe('F122 Phase A.1: TOCTOU regression', () => {
  it('AC-A10: tryStartThread returns null after thread becomes busy (simulated TOCTOU)', () => {
    // Simulates: has() returned false at T1, but another cat started at T2
    const tracker = new InvocationTracker();
    // T1: thread is idle — smart-default would compute mode='immediate'
    assert.equal(tracker.has('thread1'), false);
    // T2: A2A invocation starts (simulating async gap between has() and tryStartThread)
    tracker.start('thread1', 'catA', 'user1');
    // T3: tryStartThread — should detect busy and return null (degrade to queue)
    const result = tracker.tryStartThread('thread1', 'catB', 'user1');
    assert.equal(result, null, 'must return null — thread is now busy');
    // catA must NOT have been preempted
    assert.equal(tracker.has('thread1', 'catA'), true, 'catA slot must still be active');
  });

  it('AC-A11: tryStartThread success + duplicate create → slot must be released', () => {
    const tracker = new InvocationTracker();
    // tryStartThread succeeds (thread is idle)
    const controller = tracker.tryStartThread('thread1', 'catA', 'user1', ['catA']);
    assert.ok(controller, 'should return AbortController');
    assert.equal(tracker.has('thread1', 'catA'), true, 'slot should be registered');
    // Simulate: invocationRecordStore.create() returned duplicate → caller must complete()
    tracker.complete('thread1', 'catA', controller);
    assert.equal(tracker.has('thread1', 'catA'), false, 'slot must be released after duplicate');
    assert.equal(tracker.has('thread1'), false, 'thread must be idle after release');
  });

  it('AC-A12: multi_mention create throws → slot must be released via finally', () => {
    const tracker = new InvocationTracker();
    // start() occupies slot before create (new F122 A.1 order)
    const controller = tracker.start('thread1', 'catA', 'user1', ['catA']);
    assert.equal(tracker.has('thread1', 'catA'), true, 'slot should be occupied');
    // Simulate: invocationRecordStore.create() throws — finally block calls complete()
    try {
      throw new Error('simulated create failure');
    } catch {
      // Error handled — but slot must be released in finally
    } finally {
      tracker.complete('thread1', 'catA', controller);
    }
    // Verify slot was released
    assert.equal(tracker.has('thread1', 'catA'), false, 'slot must be released after create error');
    assert.equal(tracker.has('thread1'), false, 'thread must be idle after release');
  });

  it('AC-A10 variant: tryStartThread succeeds when same slot was previously completed', () => {
    const tracker = new InvocationTracker();
    // Cat A runs and completes
    const c1 = tracker.start('thread1', 'catA', 'user1');
    tracker.complete('thread1', 'catA', c1);
    // Now thread is idle — tryStartThread should succeed
    const c2 = tracker.tryStartThread('thread1', 'catA', 'user1', ['catA']);
    assert.ok(c2, 'should succeed after previous invocation completed');
    tracker.complete('thread1', 'catA', c2);
  });

  it('AC-A11 variant: complete with wrong controller is no-op (idempotent safety)', () => {
    const tracker = new InvocationTracker();
    const c1 = tracker.tryStartThread('thread1', 'catA', 'user1', ['catA']);
    assert.ok(c1);
    // Simulate: someone calls complete with a stale controller
    const staleController = new AbortController();
    tracker.complete('thread1', 'catA', staleController);
    // Slot should still be active (stale controller didn't match)
    assert.equal(tracker.has('thread1', 'catA'), true, 'slot must remain active with mismatched controller');
    // Proper cleanup
    tracker.complete('thread1', 'catA', c1);
    assert.equal(tracker.has('thread1', 'catA'), false);
  });
});
