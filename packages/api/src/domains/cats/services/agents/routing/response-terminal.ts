import { MEMBER_TIMEOUT_REASON } from '../invocation/member-output-timeout.js';

export type ResponseTerminalStatus = 'completed' | 'failed' | 'canceled' | 'interrupted';

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * How a member's response ends, given how its run ended — one rule for every route (F117):
 * - output the Queue refused to commit → interrupted, `output_commit_rejected`;
 * - stopped by its output timeout → failed, `timeout` (KD-22: a timeout is an ordinary failure);
 * - stopped by the user (Stop, stop all) → canceled; stopped for any other reason → interrupted;
 * - a provider failure → failed; otherwise → completed.
 * A stopped or failed response names why: its error code, else the stop reason.
 */
export function resolveResponseTerminal(input: {
  readonly aborted: boolean;
  readonly abortReason: unknown;
  readonly failed: boolean;
  readonly errorCode?: unknown;
  readonly outputCommitRejected?: boolean;
}): { readonly status: ResponseTerminalStatus; readonly reason?: string } {
  if (input.outputCommitRejected) return { status: 'interrupted', reason: 'output_commit_rejected' };
  const abortReason = nonEmpty(input.abortReason);
  if (input.aborted && abortReason === MEMBER_TIMEOUT_REASON) {
    return { status: 'failed', reason: MEMBER_TIMEOUT_REASON };
  }
  const status: ResponseTerminalStatus = input.aborted
    ? abortReason === 'user_cancel' || abortReason === 'cancel_all'
      ? 'canceled'
      : 'interrupted'
    : input.failed
      ? 'failed'
      : 'completed';
  if (status === 'completed') return { status };
  return {
    status,
    reason: nonEmpty(input.errorCode) ?? abortReason ?? (status === 'failed' ? 'provider_error' : status),
  };
}

/** Whether a member's run was stopped by its output timeout rather than by a person. */
export function stoppedByMemberTimeout(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === MEMBER_TIMEOUT_REASON;
}
