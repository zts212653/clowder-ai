export const SESSION_RECOVERY_OPENING_EVIDENCE_EVENT_LIMIT = 100;

/** Shared selector for every opening-event surface and publish allowlist. */
export function selectSessionRecoveryOpeningEvidence<T>(events: readonly T[]): T[] {
  return events.slice(0, SESSION_RECOVERY_OPENING_EVIDENCE_EVENT_LIMIT);
}
