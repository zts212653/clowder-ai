/**
 * F174 Phase A — Single source of truth for callback auth failure reasons.
 *
 * Both the API server (callback-errors.ts → makeCallbackAuthError) and the
 * MCP client (callback-tools.ts → parseAuthFailureReason) must agree on this
 * enum, otherwise the structured `[reason=X]` marker the client extracts
 * from 401 bodies can drift away from what the server emits — which would
 * silently break degradation routing in Phase E.
 *
 * Add a new reason here, then propagate to the API's MESSAGE_BY_REASON map
 * and (if it should trigger degradation) the client's DEGRADABLE_AUTH_REASONS.
 */

export const CALLBACK_AUTH_FAILURE_REASONS = [
  'expired',
  'invalid_token',
  'unknown_invocation',
  'missing_creds',
  'stale_invocation',
  'agent_key_expired',
  'agent_key_revoked',
  'agent_key_unknown',
  'agent_key_scope_mismatch',
] as const;

export type CallbackAuthFailureReason = (typeof CALLBACK_AUTH_FAILURE_REASONS)[number];

export function isCallbackAuthFailureReason(value: unknown): value is CallbackAuthFailureReason {
  return typeof value === 'string' && (CALLBACK_AUTH_FAILURE_REASONS as readonly string[]).includes(value);
}
