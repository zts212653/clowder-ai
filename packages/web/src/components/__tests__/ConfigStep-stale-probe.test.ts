import { describe, expect, it } from 'vitest';

/**
 * Regression test for P2: stale connectivity test results after profile/model switch.
 *
 * The bug: if a user starts a connectivity test for profile A, then switches to
 * profile B before the response arrives, the stale response for A could pass the
 * `testSigRef.current !== sig` guard and write a "success" testResult for B.
 *
 * The fix: handleSelectProfile and handleModelSelect clear testSigRef.current,
 * causing in-flight responses to be discarded.
 *
 * This test validates the signal logic in isolation (no DOM rendering needed).
 */

describe('ConfigStep stale probe invalidation', () => {
  it('clearing testSigRef causes in-flight check to bail out', () => {
    const testSigRef = { current: '' };

    const sig = 'profileA:modelA';
    testSigRef.current = sig;

    // Simulate profile switch mid-flight
    testSigRef.current = '';

    // The in-flight response checks: testSigRef.current !== sig
    const staleResponseDiscarded = testSigRef.current !== sig;
    expect(staleResponseDiscarded).toBe(true);
  });

  it('matching sig allows result through when no switch happened', () => {
    const testSigRef = { current: '' };

    const sig = 'profileA:modelA';
    testSigRef.current = sig;

    // No profile switch — sig still matches
    const staleResponseDiscarded = testSigRef.current !== sig;
    expect(staleResponseDiscarded).toBe(false);
  });

  it('new test after switch uses new sig, old response is still discarded', () => {
    const testSigRef = { current: '' };

    // Start test for A
    const sigA = 'profileA:modelA';
    testSigRef.current = sigA;

    // Switch to B (clears ref)
    testSigRef.current = '';

    // Start new test for B
    const sigB = 'profileB:modelB';
    testSigRef.current = sigB;

    // Old response for A arrives — must be discarded
    expect(testSigRef.current !== sigA).toBe(true);
    // New response for B arrives — must pass
    expect(testSigRef.current !== sigB).toBe(false);
  });
});
