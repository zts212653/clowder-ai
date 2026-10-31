import type { BallCustodyEvent } from '@cat-cafe/shared';

/** What a managed-hold replay mismatch tells the caller about the terminal that is already on the log. */
export interface ManagedHoldStoredTerminal {
  readonly disposition: string;
  readonly invocationId: string;
  readonly at: number;
}

/**
 * Three situations raise `managed_hold_disposition_replay_mismatch`:
 * - `existing_terminal`: the log already holds a terminal for this wake and the request disagrees with it.
 * - `existing_terminal_other_identity`: a terminal is found for this wake but belongs to another cat, source or
 *   task, or carries no valid disposition.
 * - `read_back_missing`: nothing could be read back after the write. This does NOT claim a terminal exists.
 */
export type ManagedHoldReplayMismatchBranch =
  | 'existing_terminal'
  | 'existing_terminal_other_identity'
  | 'read_back_missing';

export interface ManagedHoldReplayMismatchDetail {
  readonly branch: ManagedHoldReplayMismatchBranch;
  readonly existingTerminal?: ManagedHoldStoredTerminal;
}

/** The stored terminal an event describes, or undefined when the event is not a hold terminal at all. */
export function managedHoldStoredTerminalOf(
  event: BallCustodyEvent | undefined,
): ManagedHoldStoredTerminal | undefined {
  if (!event || event.kind !== 'ball.hold_dispositioned') return undefined;
  return {
    disposition: String(event.payload.disposition),
    invocationId: String(event.payload.invocationId),
    at: event.at,
  };
}

/** Words for the cat. Only a branch that really found a terminal may say the wake is already terminal. */
export function describeManagedHoldReplayMismatch(detail: ManagedHoldReplayMismatchDetail): string {
  const terminal = detail.existingTerminal;
  if (detail.branch === 'existing_terminal' && terminal) {
    return (
      `这个 wake 已有终态（${terminal.disposition}，invocation ${terminal.invocationId}，` +
      `at ${new Date(terminal.at).toISOString()}），不需要重试。 ` +
      `This wake already has a terminal; the call changes nothing and need not be retried.`
    );
  }
  if (detail.branch === 'existing_terminal_other_identity' && terminal) {
    return (
      `找到这个 wake 的终态，但它属于另一个 cat、source 或 task（${terminal.disposition}，invocation ` +
      `${terminal.invocationId}）。 A terminal was found for this wake but its identity does not match the request.`
    );
  }
  return (
    '写入后读不回这个 wake 的终态，终态未确认，不能当作已完成。 ' +
    'The terminal could not be read back after the write, so it is unconfirmed; do not treat it as completed.'
  );
}
