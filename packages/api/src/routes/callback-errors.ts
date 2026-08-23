/**
 * Callback auth error helpers.
 *
 * Structured { error, reason, message, hint } body so MCP clients branch on
 * lifecycle truth instead of regex-matching prose.
 *
 * The reason taxonomy lives in @cat-cafe/shared so the MCP client and the
 * API server share a single source of truth (砚砚 review reminder #2 —
 * prevent enum drift between client/server).
 */

import type { CallbackAuthFailureReason } from '@cat-cafe/shared';

/** Re-exported for backwards-compatible imports within this package. */
export type CallbackAuthErrorReason = CallbackAuthFailureReason;

export interface CallbackAuthErrorBody {
  error: 'callback_auth_failed';
  reason: CallbackAuthErrorReason;
  message: string;
  hint: string;
}

const HINT =
  '如果只是想 @队友，直接在回复文本里另起一行、行首写 @猫名，并在同一段写明确动作请求（如：请确认/请处理/请决策）。Callback credential 只绑定当前 exact TurnExecution attempt；终态后不可复活。';

const MESSAGE_BY_REASON: Record<CallbackAuthErrorReason, string> = {
  invalid_token: 'Callback token does not match invocation',
  unknown_invocation: 'Invocation id was never registered or its terminal tombstone was garbage-collected',
  missing_creds: 'Callback credentials not provided in headers or body',
  stale_invocation: 'Invocation is no longer the latest for its thread/cat slot',
  completed: 'The exact TurnExecution attempt has completed',
  failed: 'The exact TurnExecution attempt has failed',
  interrupted: 'The exact TurnExecution attempt was interrupted',
  replaced: 'The callback credential was replaced by a newer same-slot attempt',
  revoked: 'The callback credential was explicitly revoked',
  canceled: 'The exact TurnExecution attempt was canceled',
  agent_key_expired: 'Agent key has expired (45d TTL)',
  agent_key_revoked: 'Agent key has been revoked',
  agent_key_unknown: 'Agent key secret not recognized',
  agent_key_scope_mismatch: 'Agent key scope does not match request',
};

export function makeCallbackAuthError(reason: CallbackAuthErrorReason): CallbackAuthErrorBody {
  return {
    error: 'callback_auth_failed',
    reason,
    message: MESSAGE_BY_REASON[reason],
    hint: HINT,
  };
}
