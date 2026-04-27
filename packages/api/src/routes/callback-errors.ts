/**
 * Callback auth error helpers.
 *
 * F174 Phase A — Structured failure reasons. Replaces the single string-shape
 * EXPIRED_CREDENTIALS_ERROR with a discriminated body { error, reason, message, hint }
 * so MCP clients can branch on `reason` instead of regex-matching error text.
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
  '如果只是想 @队友，直接在回复文本里另起一行、行首写 @猫名，并在同一段写明确动作请求（如：请确认/请处理/请决策，免费且永不过期）。Callback token 有生命周期限制（默认约2小时，成功校验会刷新），仅用于异步中途汇报。';

const MESSAGE_BY_REASON: Record<CallbackAuthErrorReason, string> = {
  expired: 'Callback credentials expired (TTL elapsed)',
  invalid_token: 'Callback token does not match invocation',
  unknown_invocation: 'Invocation id not found (registry may have restarted)',
  missing_creds: 'Callback credentials not provided in headers or body',
  stale_invocation: 'Invocation is no longer the latest for its thread/cat slot',
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

/**
 * @deprecated F174 Phase A — use `makeCallbackAuthError(reason)` to surface
 * the precise failure reason to MCP clients. Retained for callers not yet migrated;
 * defaults to `expired` since that was the dominant interpretation pre-F174.
 */
export const EXPIRED_CREDENTIALS_ERROR = makeCallbackAuthError('expired');
