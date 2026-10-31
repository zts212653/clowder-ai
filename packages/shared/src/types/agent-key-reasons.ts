export const AGENT_KEY_FAILURE_REASONS = [
  'agent_key_expired',
  'agent_key_revoked',
  'agent_key_unknown',
  'agent_key_scope_mismatch',
] as const;

export type AgentKeyFailureReason = (typeof AGENT_KEY_FAILURE_REASONS)[number];

export function isAgentKeyFailureReason(value: unknown): value is AgentKeyFailureReason {
  return typeof value === 'string' && (AGENT_KEY_FAILURE_REASONS as readonly string[]).includes(value);
}
