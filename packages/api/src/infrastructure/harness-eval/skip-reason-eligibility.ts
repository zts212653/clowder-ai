/**
 * F257 V2 — skip-reason escalation eligibility registry.
 *
 * Sol verdict `2026-07-21-harness-ledger-dedup-active-false-escalation-c3`:
 * `checkGuardThreshold` counted ALL `a2a_route_decision_skip` episodes
 * toward 3/7d harmful-rejection escalation, but `dedup_active` is a
 * HEALTHY delivery-dedup mechanism (cat already processing, skip is
 * correct behavior). Escalating it misclassifies normal operation as harm.
 *
 * This registry declares which skip reasons are ELIGIBLE for harmful-
 * rejection escalation. The full message-lifecycle cutover removed the old
 * routing-decision producer, so this registry now owns the canonical set of
 * legacy guard reasons consumed by the ledger. Unknown reasons still fail
 * closed at the query boundary.
 *
 * Design: declarative data (not control flow), same pattern as
 * `guard-ledger-registry.ts`. Null-prototype + deep-frozen for immutability.
 *
 * The explicit union below keeps registry classification exhaustive without
 * reintroducing the deleted routing-decision runtime.
 *
 * [宪宪/claude-opus-4-6🐾]
 */

// ---------------------------------------------------------------------------
// Skip-reason classification
// ---------------------------------------------------------------------------

/**
 * Category for observability — what kind of skip this is.
 * - 'delivery_dedup': healthy re-delivery suppression (cat already active)
 * - 'safety_guard': harmful pattern blocked (pingpong, depth loops)
 * - 'abort': user/system-initiated abort
 */
export type SkipReasonCategory = 'delivery_dedup' | 'safety_guard' | 'abort';

export interface SkipReasonEntry {
  /** Whether this reason counts toward harmful-rejection escalation. */
  readonly eligible: boolean;
  /** Observability classification. */
  readonly category: SkipReasonCategory;
  /** Human-readable explanation for verdict/bundle attribution. */
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness (sol R2 P2-1)
// ---------------------------------------------------------------------------

/**
 * Canonical legacy guard reasons accepted by the lifecycle ledger.
 * Registry classification remains compile-time exhaustive over this union.
 */
export type EmittedSkipReason = 'depth' | 'dedup_active' | 'aborted' | 'pingpong_streak';

// ---------------------------------------------------------------------------
// Registry (sol R1 P3-1: deep-frozen; sol R2 P2-1: exhaustive)
// ---------------------------------------------------------------------------

/**
 * Known entries — compile-time exhaustive over EmittedSkipReason.
 * If a producer adds a new reason, TypeScript fails here until classified.
 */
const knownEntries = {
  dedup_active: Object.freeze({
    eligible: false,
    category: 'delivery_dedup' as const,
    description: 'Cat already processing in InvocationQueue — skip is correct delivery dedup, not a harmful rejection.',
  }),
  depth: Object.freeze({
    eligible: true,
    category: 'safety_guard' as const,
    description: 'A2A chain depth limit reached — may indicate runaway mention loops (chain safety guard).',
  }),
  aborted: Object.freeze({
    eligible: false,
    category: 'abort' as const,
    description: 'User or system abort — intentional cancellation, not a guard rejection.',
  }),
  pingpong_streak: Object.freeze({
    eligible: true,
    category: 'safety_guard' as const,
    description: 'A2A pingpong streak blocked — harmful bidirectional loop.',
  }),
} satisfies Record<EmittedSkipReason, SkipReasonEntry>;

/** Null-prototype + frozen: prototype keys can't collide, entries can't mutate. */
const entries: Record<string, SkipReasonEntry> = Object.assign(
  Object.create(null) as Record<string, SkipReasonEntry>,
  knownEntries,
);

export const SKIP_REASON_ELIGIBILITY: Readonly<Record<string, SkipReasonEntry>> = Object.freeze(entries);

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

/**
 * Is a skip reason eligible for harmful-rejection escalation?
 *
 * Unknown reasons default to ELIGIBLE (fail-closed: a new reason that
 * nobody classified yet should still escalate — false positive is safer
 * than silent suppression of a new harmful pattern).
 */
export function isEscalationEligible(normalizedReason: string | undefined): boolean {
  if (!normalizedReason) return true; // missing reason → eligible (fail-closed)
  const entry = Object.hasOwn(SKIP_REASON_ELIGIBILITY, normalizedReason)
    ? SKIP_REASON_ELIGIBILITY[normalizedReason]
    : undefined;
  return entry ? entry.eligible : true; // unknown reason → eligible (fail-closed)
}

/**
 * Get the category for a skip reason (observability / bundle breakdown).
 * Returns 'unknown' for unregistered reasons.
 */
export function skipReasonCategory(normalizedReason: string): SkipReasonCategory | 'unknown' {
  const entry = Object.hasOwn(SKIP_REASON_ELIGIBILITY, normalizedReason)
    ? SKIP_REASON_ELIGIBILITY[normalizedReason]
    : undefined;
  return entry ? entry.category : 'unknown';
}
