import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { A2ADispatchReplacement } from './A2ADispatchReplacementResolver.js';

/**
 * Where the stored terminal came from. `unknown` is its own answer: a terminal written before provenance was
 * recorded is not guessed to be either of the two.
 */
export type A2ADispatchTerminalSource = 'direct' | 'coordination_terminal' | 'unknown';

/** What an `existing_terminal` mismatch tells the caller about the terminal that is already on the log. */
export interface A2ADispatchStoredTerminal {
  readonly disposition: string;
  readonly invocationId: string;
  readonly at: number;
  readonly source: A2ADispatchTerminalSource;
}

/**
 * Two different situations raise `a2a_dispatch_disposition_replay_mismatch`:
 * - `existing_terminal`: an authoritative terminal is already on the log for this exact invocation and source,
 *   and the request disagrees with it. The source IS terminal; retrying cannot change that.
 * - `read_back_missing`: nothing could be read back after the write. This does NOT claim a terminal exists.
 */
export type A2ADispatchReplayMismatchBranch = 'existing_terminal' | 'read_back_missing';

export interface A2ADispatchReplayMismatchDetail {
  readonly branch: A2ADispatchReplayMismatchBranch;
  readonly existingTerminal?: A2ADispatchStoredTerminal;
}

export class A2ADispatchDispositionError extends Error {
  readonly branch?: A2ADispatchReplayMismatchBranch;
  readonly existingTerminal?: A2ADispatchStoredTerminal;

  constructor(
    readonly code: string,
    readonly replacement?: A2ADispatchReplacement,
    detail?: A2ADispatchReplayMismatchDetail,
  ) {
    super(code);
    this.name = 'A2ADispatchDispositionError';
    if (detail) {
      this.branch = detail.branch;
      if (detail.existingTerminal) this.existingTerminal = detail.existingTerminal;
    }
  }
}

function terminalSourceOf(payload: BallCustodyEvent['payload']): A2ADispatchTerminalSource {
  return payload.via === 'direct' || payload.via === 'coordination_terminal' ? payload.via : 'unknown';
}

/** The stored terminal an event describes, or undefined when the event is not a dispatch terminal at all. */
export function storedTerminalOf(event: BallCustodyEvent | undefined): A2ADispatchStoredTerminal | undefined {
  if (!event || event.kind !== 'ball.dispatch_dispositioned') return undefined;
  return {
    disposition: String(event.payload.disposition),
    invocationId: String(event.payload.invocationId),
    at: event.at,
    source: terminalSourceOf(event.payload),
  };
}

/** The error for a request that disagrees with, or cannot confirm, the terminal on the log. */
export function dispatchReplayMismatch(event: BallCustodyEvent | undefined): A2ADispatchDispositionError {
  const existingTerminal = storedTerminalOf(event);
  return new A2ADispatchDispositionError(
    'a2a_dispatch_disposition_replay_mismatch',
    undefined,
    existingTerminal ? { branch: 'existing_terminal', existingTerminal } : { branch: 'read_back_missing' },
  );
}

/** Words for the cat. Only the `existing_terminal` branch may say the source is already terminal. */
export function describeDispatchReplayMismatch(error: A2ADispatchDispositionError): string | undefined {
  if (error.code !== 'a2a_dispatch_disposition_replay_mismatch') return undefined;
  const terminal = error.existingTerminal;
  if (error.branch === 'existing_terminal' && terminal) {
    return (
      `这条 source 已有终态（${terminal.disposition}，invocation ${terminal.invocationId}，` +
      `at ${new Date(terminal.at).toISOString()}，来源 ${terminal.source}），不需要重试。 ` +
      `This source already has a terminal; the call changes nothing and need not be retried.`
    );
  }
  if (error.branch === 'read_back_missing') {
    return (
      '写入后读不回这条终态，终态未确认，不能当作已完成。 ' +
      'The terminal could not be read back after the write, so it is unconfirmed; do not treat it as completed.'
    );
  }
  return undefined;
}
