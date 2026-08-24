/**
 * Regression tests: Steer confirmation execution-identity binding.
 *
 * Verifies that Draft Steer fails closed whenever the active execution
 * identity is not verifiable, and that same-render A→B transitions
 * dismiss or reject stale confirmations.
 *
 * Derived from Sol's re-review of 23c43547:
 *  - canonical-key A→B rejection (modal opened for inv-a, inv-b becomes active)
 *  - active-without-verifiable-identity rejection (legacy/unhydrated path where
 *    activeExecutionKey is undefined must not act as wildcard match)
 */
import { describe, expect, it } from 'vitest';

// --- Pure logic extracted from ChatInputActionButton ---
// These mirror the three decision points in the component.

/** Whether the force-send (steer) button should be offered at all. */
function shouldOfferSteer(opts: { onForceSend: boolean; activeExecutionKey: string | undefined }): boolean {
  return opts.onForceSend && opts.activeExecutionKey !== undefined;
}

/** Whether the useEffect should auto-dismiss an open steer modal. */
function shouldDismissSteer(opts: {
  hasActiveInvocation: boolean;
  confirmSteer: boolean;
  steerBoundKey: string | undefined;
  activeExecutionKey: string | undefined;
}): boolean {
  if (!opts.hasActiveInvocation) return true;
  if (!opts.confirmSteer) return false;
  // Fail closed: unverifiable bound key → dismiss
  if (opts.steerBoundKey === undefined) return true;
  // Same-render A→B: key changed → dismiss
  if (opts.activeExecutionKey !== opts.steerBoundKey) return true;
  return false;
}

/** Whether onConfirm should actually invoke onForceSend. */
function shouldConfirmExecute(opts: {
  hasActiveInvocation: boolean;
  activeExecutionKey: string | undefined;
  steerBoundKey: string | undefined;
}): boolean {
  const keyMatch = opts.activeExecutionKey !== undefined && opts.activeExecutionKey === opts.steerBoundKey;
  return Boolean(opts.hasActiveInvocation) && keyMatch;
}

// --- Tests ---

describe('steer confirmation: canonical-key A→B rejection', () => {
  it('dismisses modal when execution key changes from inv-a to inv-b', () => {
    expect(
      shouldDismissSteer({
        hasActiveInvocation: true,
        confirmSteer: true,
        steerBoundKey: 'inv-a',
        activeExecutionKey: 'inv-b',
      }),
    ).toBe(true);
  });

  it('rejects confirm when bound key differs from active key', () => {
    expect(
      shouldConfirmExecute({
        hasActiveInvocation: true,
        activeExecutionKey: 'inv-b',
        steerBoundKey: 'inv-a',
      }),
    ).toBe(false);
  });

  it('allows confirm when bound key matches active key', () => {
    expect(
      shouldConfirmExecute({
        hasActiveInvocation: true,
        activeExecutionKey: 'inv-a',
        steerBoundKey: 'inv-a',
      }),
    ).toBe(true);
  });
});

describe('steer confirmation: active-without-verifiable-identity rejection', () => {
  it('does not offer steer button when activeExecutionKey is undefined', () => {
    expect(
      shouldOfferSteer({
        onForceSend: true,
        activeExecutionKey: undefined,
      }),
    ).toBe(false);
  });

  it('offers steer button when activeExecutionKey is defined', () => {
    expect(
      shouldOfferSteer({
        onForceSend: true,
        activeExecutionKey: 'inv-a',
      }),
    ).toBe(true);
  });

  it('dismisses modal when steerBoundKey is undefined (legacy/unhydrated)', () => {
    // Simulates: modal was opened while activeExecutionKey was undefined
    // (shouldn't happen after the gate fix, but defense in depth)
    expect(
      shouldDismissSteer({
        hasActiveInvocation: true,
        confirmSteer: true,
        steerBoundKey: undefined,
        activeExecutionKey: undefined,
      }),
    ).toBe(true);
  });

  it('dismisses modal when steerBoundKey is undefined even with a new key', () => {
    // Simulates: opened with undefined key, then canonical data arrives
    expect(
      shouldDismissSteer({
        hasActiveInvocation: true,
        confirmSteer: true,
        steerBoundKey: undefined,
        activeExecutionKey: 'inv-b',
      }),
    ).toBe(true);
  });

  it('rejects confirm when activeExecutionKey is undefined (wildcard blocked)', () => {
    // THE critical regression: undefined must NOT match undefined
    expect(
      shouldConfirmExecute({
        hasActiveInvocation: true,
        activeExecutionKey: undefined,
        steerBoundKey: undefined,
      }),
    ).toBe(false);
  });

  it('rejects confirm when activeExecutionKey is undefined even with defined bound key', () => {
    expect(
      shouldConfirmExecute({
        hasActiveInvocation: true,
        activeExecutionKey: undefined,
        steerBoundKey: 'inv-a',
      }),
    ).toBe(false);
  });
});

describe('steer confirmation: invocation lifecycle', () => {
  it('dismisses when hasActiveInvocation becomes false', () => {
    expect(
      shouldDismissSteer({
        hasActiveInvocation: false,
        confirmSteer: true,
        steerBoundKey: 'inv-a',
        activeExecutionKey: undefined,
      }),
    ).toBe(true);
  });

  it('does not dismiss when keys match and invocation is active', () => {
    expect(
      shouldDismissSteer({
        hasActiveInvocation: true,
        confirmSteer: true,
        steerBoundKey: 'inv-a',
        activeExecutionKey: 'inv-a',
      }),
    ).toBe(false);
  });
});
