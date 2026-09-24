import { describe, expect, it } from 'vitest';
import {
  decideHoldCancelEntry,
  type HoldCardRef,
  readHoldCardCancelability,
} from '../types/hold-card-cancelability.js';

/**
 * Meta shapes copied from the real producers at the commit this contract was
 * introduced, so a producer that stops stating the fact fails here rather than
 * only in the browser. The comment on each names the file it came from.
 */
const PRODUCER_META = {
  /** callback-hold-ball-routes.ts — the one still-cancelable card. */
  waiting: { managedHold: true, phase: 'waiting', cancelable: true, mode: 'command', taskId: 't1' },
  /** callback-hold-ball-routes.ts — launch cancellation. */
  launchCanceled: { managedHold: true, phase: 'status', cancelable: false, taskId: 't1' },
  /** ManagedCommandWakeRecoveryEngine.ts — spawn/runner loss. */
  runnerLost: { managedHold: true, phase: 'status', cancelable: false, taskId: 't1', recoverySource: 'command_runner' },
  /** TaskRunnerV2.ts — missed wake window. */
  missedWindow: { managedHold: true, phase: 'status', cancelable: false, taskId: 't1' },
  /** reminder.ts — wake-admission failure. */
  wakeFailed: { managedHold: true, phase: 'status', cancelable: false, taskId: 't1' },
  /** RetiredManagedCommandTerminalRecovery.ts — marks terminal with no phase at all. */
  terminalReceipt: { taskId: 't1', wakeWhen: true, terminalReceipt: true, cancelable: false },
} as const;

function card(id: string, timestamp: number, meta: unknown): HoldCardRef {
  return { id, timestamp, cancelability: readHoldCardCancelability(meta) };
}

describe('readHoldCardCancelability', () => {
  it('reads the producer-stated fact, not the presentation phase', () => {
    expect(readHoldCardCancelability(PRODUCER_META.waiting)).toBe('cancelable');
    expect(readHoldCardCancelability(PRODUCER_META.launchCanceled)).toBe('terminal');
    expect(readHoldCardCancelability(PRODUCER_META.runnerLost)).toBe('terminal');
    expect(readHoldCardCancelability(PRODUCER_META.missedWindow)).toBe('terminal');
    expect(readHoldCardCancelability(PRODUCER_META.wakeFailed)).toBe('terminal');
    expect(readHoldCardCancelability(PRODUCER_META.terminalReceipt)).toBe('terminal');
  });

  it('treats every exceptional terminal as terminal even though its phase is the non-terminal-looking "status"', () => {
    // The defect this contract exists for: these four all said phase:'status',
    // which the old consumer copy did not list as terminal.
    for (const meta of [
      PRODUCER_META.launchCanceled,
      PRODUCER_META.runnerLost,
      PRODUCER_META.missedWindow,
      PRODUCER_META.wakeFailed,
    ]) {
      expect(meta.phase).toBe('status');
      expect(readHoldCardCancelability(meta)).toBe('terminal');
    }
  });

  it('says "unstated" for cards written before the contract, so the probe still decides', () => {
    expect(readHoldCardCancelability({ managedHold: true, phase: 'status', taskId: 't1' })).toBe('unstated');
    expect(readHoldCardCancelability(undefined)).toBe('unstated');
    expect(readHoldCardCancelability(null)).toBe('unstated');
    expect(readHoldCardCancelability([])).toBe('unstated');
    expect(readHoldCardCancelability({ cancelable: 'false' })).toBe('unstated');
  });
});

describe('decideHoldCancelEntry', () => {
  it('revokes cancel on every card of the hold once any card states a terminal', () => {
    const cards = [card('m1', 100, PRODUCER_META.waiting), card('m2', 200, PRODUCER_META.runnerLost)];
    expect(decideHoldCancelEntry('m1', cards)).toBe('revoked');
    expect(decideHoldCancelEntry('m2', cards)).toBe('revoked');
  });

  it.each([
    ['launch cancellation', PRODUCER_META.launchCanceled],
    ['spawn/runner loss', PRODUCER_META.runnerLost],
    ['missed wake window', PRODUCER_META.missedWindow],
    ['wake-admission failure', PRODUCER_META.wakeFailed],
  ])('revokes the still-open waiting card after %s', (_name, terminalMeta) => {
    const cards = [card('m1', 100, PRODUCER_META.waiting), card('m2', 200, terminalMeta)];
    // The original waiting card is the one the operator saw keep its buttons.
    expect(decideHoldCancelEntry('m1', cards)).toBe('revoked');
  });

  it('exposes exactly one cancel entry while the hold is still active', () => {
    const cards = [card('m1', 100, PRODUCER_META.waiting), card('m2', 200, PRODUCER_META.waiting)];
    const owners = cards.filter((c) => decideHoldCancelEntry(c.id, cards) === 'owner');
    expect(owners.map((c) => c.id)).toEqual(['m2']);
  });

  it('elects exactly one owner regardless of the order the timeline hands the cards over', () => {
    const cards = [card('m2', 200, PRODUCER_META.waiting), card('m1', 100, PRODUCER_META.waiting)];
    expect(cards.filter((c) => decideHoldCancelEntry(c.id, cards) === 'owner')).toHaveLength(1);
  });

  it('breaks a same-timestamp tie on the sortable id instead of electing two owners', () => {
    const cards = [card('m1', 100, PRODUCER_META.waiting), card('m2', 100, PRODUCER_META.waiting)];
    const owners = cards.filter((c) => decideHoldCancelEntry(c.id, cards) === 'owner');
    expect(owners.map((c) => c.id)).toEqual(['m2']);
  });

  it('never leaves an active hold with zero cancel entries', () => {
    const cards = [card('only', 100, PRODUCER_META.waiting)];
    expect(decideHoldCancelEntry('only', cards)).toBe('owner');
  });

  it('leaves an unstated-only hold to the probe by keeping an owner', () => {
    const legacy = { managedHold: true, phase: 'waiting', taskId: 't1' };
    const cards = [card('m1', 100, legacy), card('m2', 200, legacy)];
    expect(decideHoldCancelEntry('m2', cards)).toBe('owner');
    expect(decideHoldCancelEntry('m1', cards)).toBe('not_owner');
  });
});
