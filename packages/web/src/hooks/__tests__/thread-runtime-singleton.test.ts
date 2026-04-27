/**
 * F173 Phase B: Singleton lifecycle tests.
 *
 * The singleton must:
 *  - Return the same ledger instance across calls
 *  - Reset on resetThreadRuntimeSingleton (test isolation)
 *  - Survive module re-import (process-singleton, not module-level new ref)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getActiveBubble,
  isInvocationReplaced,
  markInvocationReplaced,
  setActiveBubble,
} from '../thread-runtime-ledger';
import { getThreadRuntimeLedger, resetThreadRuntimeSingleton } from '../thread-runtime-singleton';

describe('F173 Phase B: thread-runtime singleton', () => {
  beforeEach(() => {
    resetThreadRuntimeSingleton();
  });

  it('returns the same ledger across calls', () => {
    const a = getThreadRuntimeLedger();
    const b = getThreadRuntimeLedger();
    expect(a).toBe(b);
  });

  it('preserves state across multiple getThreadRuntimeLedger calls', () => {
    setActiveBubble(getThreadRuntimeLedger(), 'thread-1', 'opus', { messageId: 'msg-1', invocationId: 'inv-A' });
    const got = getActiveBubble(getThreadRuntimeLedger(), 'thread-1', 'opus');
    expect(got?.messageId).toBe('msg-1');
  });

  it('resetThreadRuntimeSingleton wipes prior state', () => {
    markInvocationReplaced(getThreadRuntimeLedger(), 'thread-1', 'opus', 'inv-A', 60_000);
    expect(isInvocationReplaced(getThreadRuntimeLedger(), 'thread-1', 'opus', 'inv-A')).toBe(true);
    resetThreadRuntimeSingleton();
    expect(isInvocationReplaced(getThreadRuntimeLedger(), 'thread-1', 'opus', 'inv-A')).toBe(false);
  });

  it('after reset, returns a different ledger reference', () => {
    const before = getThreadRuntimeLedger();
    resetThreadRuntimeSingleton();
    const after = getThreadRuntimeLedger();
    expect(after).not.toBe(before);
  });
});
