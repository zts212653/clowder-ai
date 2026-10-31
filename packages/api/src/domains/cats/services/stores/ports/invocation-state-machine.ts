/**
 * InvocationStatus State Machine — F25 explicit transition spec.
 *
 * Previously implicit in CAS guards and route handlers.
 * Now a single source of truth for legal status transitions.
 *
 * ADR-008 D1: InvocationRecord lifecycle.
 */

/**
 * Status type re-declared here to avoid circular dependency with InvocationRecordStore.
 * Structurally identical to InvocationStatus in InvocationRecordStore.ts.
 */
type InvocationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/**
 * Recovery meaning of a persisted invocation status.
 *
 * A record proves durable identity, not durable execution. Only `succeeded`
 * proves the requested work completed. `queued` and `failed` retain an exact
 * replay transition, while `running` is owned by the current executor and
 * `canceled` is terminal without success.
 */
export type InvocationRecoveryStatus = 'replayable' | 'in_flight' | 'completed' | 'terminal';

/**
 * Legal state transitions, derived from production call sites:
 *
 * queued  → running   (normal execution start)
 * queued  → failed    (pre-start failure: e.g. running update throws)
 * queued  → canceled  (delete race: message deleted before cat starts)
 * running → succeeded (normal completion)
 * running → failed    (error / persistence failure)
 * running → canceled  (user cancels during execution)
 * failed  → running   (retry: CAS-protected re-claim)
 * failed  → canceled  (delete race on retry)
 */
const VALID_TRANSITIONS: ReadonlyMap<InvocationStatus, ReadonlySet<InvocationStatus>> = new Map([
  ['queued', new Set<InvocationStatus>(['running', 'failed', 'canceled'])],
  ['running', new Set<InvocationStatus>(['succeeded', 'failed', 'canceled'])],
  ['failed', new Set<InvocationStatus>(['running', 'canceled'])],
  ['succeeded', new Set<InvocationStatus>()],
  ['canceled', new Set<InvocationStatus>()],
]);

/** Terminal states — no outbound transitions allowed. */
export const TERMINAL_STATES: ReadonlySet<InvocationStatus> = new Set(['succeeded', 'canceled']);

/** All valid InvocationStatus values. */
export const ALL_STATUSES: readonly InvocationStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const;

export function classifyInvocationRecoveryStatus(status: InvocationStatus): InvocationRecoveryStatus {
  switch (status) {
    case 'queued':
    case 'failed':
      return 'replayable';
    case 'running':
      return 'in_flight';
    case 'succeeded':
      return 'completed';
    case 'canceled':
      return 'terminal';
  }
}

/**
 * Check whether a status transition is legal.
 * Pure function, no side effects.
 */
export function isValidTransition(from: InvocationStatus, to: InvocationStatus): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

/**
 * Get allowed target states for a given status.
 * Useful for testing and error messages.
 */
export function getAllowedTransitions(from: InvocationStatus): readonly InvocationStatus[] {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed) return [];
  return [...allowed];
}
