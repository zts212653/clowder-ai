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
 * rejection escalation. Classification authority belongs to the PRODUCER
 * (`routing-decision.ts` defines the reason enum), not the escalation
 * layer — Fable architecture ruling.
 *
 * Design: declarative data (not control flow), same pattern as
 * `guard-ledger-registry.ts`. Null-prototype + deep-frozen for immutability.
 *
 * Sol R2 P2-1: compile-time exhaustive against producer union. Adding a
 * reason to RoutingDecision without updating this registry is a compile
 * error (satisfies Record<EmittedSkipReason, ...>).
 *
 * Sol R3 P2-1: `pingpong_streak` is now a producer-typed reason on the
 * `block_pingpong` action in routing-decision.ts (no longer hand-written
 * SyntheticSkipReason). Both `skip.reason` and `block_pingpong.reason`
 * are extracted from the RoutingDecision union.
 *
 * [宪宪/claude-opus-4-6🐾]
 */

import type { RoutingDecision } from '../../domains/cats/services/agents/routing/routing-decision.js';

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

/** Skip reasons from routing-decision.ts producer union (after queue_pending removal). */
type RoutingSkipReason = Extract<RoutingDecision, { action: 'skip' }>['reason'];

/**
 * Sol R3 P2-1: block_pingpong reason is now part of the RoutingDecision
 * union (producer-defined), not a hand-written synthetic string. Extracted
 * the same way as skip reasons — compile-time bound to the producer type.
 */
type RoutingBlockReason = Extract<RoutingDecision, { action: 'block_pingpong' }>['reason'];

/**
 * Union of ALL actually-emitted skip reasons from all producers.
 * Registry must classify every member — `satisfies` enforces this at compile time.
 * Both `skip` and `block_pingpong` actions carry typed `reason` fields;
 * adding a new reason without updating this registry is a compile error.
 */
export type EmittedSkipReason = RoutingSkipReason | RoutingBlockReason;

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
