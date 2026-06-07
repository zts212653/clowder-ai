import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CancelBurstDetector } from '../../dist/infrastructure/harness-eval/task-outcome/cancel-burst-detector.js';

describe('Cancel Burst Detector (F192 Phase G AC-G13)', () => {
  /** @type {CancelBurstDetector} */
  let detector;

  beforeEach(() => {
    detector = new CancelBurstDetector({ threshold: 3, windowMs: 60_000 });
  });

  it('does not fire on first cancel', () => {
    const result = detector.record('thread_a', Date.now());
    assert.equal(result.burst, false);
  });

  it('does not fire on second cancel', () => {
    const now = Date.now();
    detector.record('thread_a', now);
    const result = detector.record('thread_a', now + 1000);
    assert.equal(result.burst, false);
  });

  it('fires on third cancel within window', () => {
    const now = Date.now();
    detector.record('thread_a', now);
    detector.record('thread_a', now + 1000);
    const result = detector.record('thread_a', now + 2000);
    assert.equal(result.burst, true);
    assert.equal(result.count, 3);
  });

  it('does not fire if cancels spread across window boundary', () => {
    const now = Date.now();
    detector.record('thread_a', now);
    detector.record('thread_a', now + 30_000);
    // Third cancel is outside the window from first
    const result = detector.record('thread_a', now + 61_000);
    assert.equal(result.burst, false);
  });

  it('tracks threads independently', () => {
    const now = Date.now();
    detector.record('thread_a', now);
    detector.record('thread_a', now + 1000);
    detector.record('thread_b', now + 2000);
    // Third cancel on thread_a
    const resultA = detector.record('thread_a', now + 3000);
    assert.equal(resultA.burst, true);
    // Only second cancel on thread_b
    const resultB = detector.record('thread_b', now + 4000);
    assert.equal(resultB.burst, false);
  });

  it('resets after burst fires', () => {
    const now = Date.now();
    detector.record('thread_a', now);
    detector.record('thread_a', now + 1000);
    detector.record('thread_a', now + 2000); // burst fires
    // Next cancel starts fresh count
    const result = detector.record('thread_a', now + 3000);
    assert.equal(result.burst, false);
  });

  it('respects custom threshold', () => {
    const d = new CancelBurstDetector({ threshold: 2, windowMs: 60_000 });
    const now = Date.now();
    d.record('thread_a', now);
    const result = d.record('thread_a', now + 1000);
    assert.equal(result.burst, true);
    assert.equal(result.count, 2);
  });
});
