import type { LifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import { describeToolAction, type ToolAction } from './tool-action';

/**
 * F322 B — §1.16 合同二/合同三: the one line that says what a reply is doing, as a pure function of facts about THIS reply.
 *
 * Only a running reply and one that did not end well have a status; a reply that finished normally has none ("正常做完不写已完成").
 * Two states of the design have no producer in the data yet and are therefore not derivable here: 结果待确认 (a finished reply whose
 * result cannot be read) and 已暂停，等你决定 (a reply waiting on an approval card). They are added when a source for them exists.
 */
export type ReplyFailureReason = 'response_timeout' | 'stall_timeout' | 'silent_completion';

/**
 * `working.action` is the latest tool call, null while the cat is only writing. `quiet.quietForMs` is null when the start of the
 * silence is not known (minutes are never invented).
 */
export type ReplyStatus =
  | { kind: 'working'; action: ToolAction | null }
  | { kind: 'quiet'; quietForMs: number | null }
  | { kind: 'unverified' }
  | { kind: 'failed'; reason: ReplyFailureReason | null }
  | { kind: 'stopped' };

export interface ReplyStatusInput {
  /** This reply's own stream flag. */
  streaming: boolean;
  /** The named response's durable lifecycle status. */
  status: Extract<LifecycleStoredMessageMetadata, { kind: 'response' }>['status'] | undefined;
  /** The message itself is an error. */
  errored: boolean;
  failure: { reasonCode: string | undefined; timeoutDiagnostics: boolean };
  /**
   * The cat went quiet AND the quiet turn is this reply's own turn (the caller matched `turnInvocationId`); `since` is the last
   * activity when the lifecycle knows it. null = not quiet, or not this reply's turn.
   */
  quiet: { since: number | null } | null;
  now: number;
  /** The latest tool_use of this reply. */
  latestToolUse: { label: string; detail?: string } | null;
}

export type ReplyExecutionState = 'running' | 'terminal' | 'unverified';

export function deriveReplyExecutionState(
  input: Pick<ReplyStatusInput, 'streaming' | 'status' | 'errored'>,
): ReplyExecutionState {
  if (
    input.errored ||
    input.status === 'completed' ||
    input.status === 'failed' ||
    input.status === 'canceled' ||
    input.status === 'interrupted'
  ) {
    return 'terminal';
  }
  if (input.status === 'processing') return 'running';
  return input.streaming ? 'running' : 'terminal';
}

function failureReason(failure: ReplyStatusInput['failure']): ReplyFailureReason | null {
  switch (failure.reasonCode) {
    case 'cli_response_timeout':
      return 'response_timeout';
    case 'cli_stall_timeout':
      return 'stall_timeout';
    case 'silent_completion':
      return 'silent_completion';
    default:
      return failure.timeoutDiagnostics && failure.reasonCode === undefined ? 'response_timeout' : null;
  }
}

export function deriveReplyStatus(input: ReplyStatusInput): ReplyStatus | null {
  if (input.status === 'canceled' || input.status === 'interrupted') return { kind: 'stopped' };
  if (input.status === 'failed' || input.errored) return { kind: 'failed', reason: failureReason(input.failure) };
  const execution = deriveReplyExecutionState(input);
  if (execution === 'unverified') return { kind: 'unverified' };
  if (execution === 'terminal') return null;
  if (input.quiet) {
    return {
      kind: 'quiet',
      quietForMs: input.quiet.since === null ? null : Math.max(0, input.now - input.quiet.since),
    };
  }
  const tool = input.latestToolUse;
  return { kind: 'working', action: tool ? describeToolAction(tool.label, tool.detail) : null };
}
