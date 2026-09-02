/**
 * F167 — Stranded producer recovery state machine.
 *
 * A narrow, CAS-fenced mechanism for recovering a lease whose holder carrier
 * demonstrably cannot produce the required terminal predicate (e.g. native
 * kimi-code 0.34 with no MCP tool access).
 *
 * Guards:
 *  - exact lease generation
 *  - lease must be active (not completed/replaceable)
 *  - holder must be in holderCatIds
 *  - predicate kind and digest must match
 *  - capability witness must be `unavailable`
 *  - no existing outcomes (would compete with late verdict)
 *  - no completion candidates (verdict in progress)
 *  - no active return delivery (pending/overdue — NOT historical transitions)
 *  - no active dispatch delivery reservation (carrier may be delivering)
 *
 * The recovery marks the holder outcome as `unavailable`, which transitions
 * the lease to `replaceable` (for single-holder leases), enabling the issuer
 * to replace the generation with a capable carrier.
 *
 * Competes with late-arriving typed verdict: if a verdict/outcome/candidate
 * already exists, recovery yields to it (single-winner semantics).
 */

import { recordActionSuccessorOutcome } from './action-successor-outcome-state-machine.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export interface RecoverStrandedProducerInput {
  readonly expectedGeneration: number;
  readonly holderCatId: string;
  readonly capabilityWitness: {
    readonly provider: string;
    readonly carrier: string;
    readonly status: 'unavailable' | 'available';
    readonly reason: string;
  };
  readonly predicateKind: string;
  readonly predicateDigest: string;
  readonly evidenceRef: string;
  readonly now: number;
}

export type RecoverStrandedProducerResult =
  | { readonly outcome: 'recovered'; readonly lease: ActionSuccessorLease }
  | { readonly outcome: 'replayed'; readonly lease: ActionSuccessorLease }
  | {
      readonly outcome:
        | 'stale_generation'
        | 'lease_not_active'
        | 'identity_mismatch'
        | 'holder_mismatch'
        | 'output_present'
        | 'candidate_present'
        | 'return_present'
        | 'dispatch_reserved'
        | 'predicate_mismatch'
        | 'capability_not_unavailable';
      readonly lease: ActionSuccessorLease;
    };

/**
 * Pure state-machine transition for stranded producer recovery.
 * Restart-safe: deterministic for the same (lease, input) pair.
 */
export function recoverStrandedProducer(
  current: ActionSuccessorLease,
  input: RecoverStrandedProducerInput,
): RecoverStrandedProducerResult {
  // ── Guard: capability witness must be unavailable ──
  if (input.capabilityWitness.status !== 'unavailable') {
    return { outcome: 'capability_not_unavailable', lease: current };
  }

  // ── Guard: exact generation ──
  if (current.generation !== input.expectedGeneration) {
    return { outcome: 'stale_generation', lease: current };
  }

  // ── Guard: predicate kind match ──
  if (current.terminalPredicate?.kind !== input.predicateKind) {
    return { outcome: 'identity_mismatch', lease: current };
  }

  // ── Guard: predicate digest match ──
  if (current.terminalPredicate?.digest !== input.predicateDigest) {
    return { outcome: 'predicate_mismatch', lease: current };
  }

  // ── Guard: holder must be in holderCatIds ──
  if (!current.holderCatIds.includes(input.holderCatId)) {
    return { outcome: 'holder_mismatch', lease: current };
  }

  // ── Replay detection: check if already recovered ──
  const existingOutcome = current.holderOutcomes[input.holderCatId];
  if (existingOutcome) {
    if (existingOutcome.outcome === 'unavailable' && existingOutcome.evidenceRef === input.evidenceRef) {
      return { outcome: 'replayed', lease: current };
    }
    // A different outcome already exists (late verdict won the race)
    return { outcome: 'output_present', lease: current };
  }

  // ── Guard: lease must be active ──
  if (current.status !== 'active') {
    return { outcome: 'lease_not_active', lease: current };
  }

  // ── Guard: no existing outcomes from other holders (verdict race) ──
  if (Object.keys(current.holderOutcomes).length > 0) {
    return { outcome: 'output_present', lease: current };
  }

  // ── Guard: no completion candidates (verdict in progress) ──
  if (Object.keys(current.completionCandidates).length > 0) {
    return { outcome: 'candidate_present', lease: current };
  }

  // ── Guard: no ACTIVE return delivery (custody return in progress) ──
  // returnTransitions is an audit trail preserved across reattach; only
  // an active returnDeliveryState (pending/overdue) indicates a live return.
  if (current.returnDeliveryState === 'pending' || current.returnDeliveryState === 'overdue') {
    return { outcome: 'return_present', lease: current };
  }

  // ── Guard: no active dispatch delivery reservation ──
  // Dispatch recovery does reserve → external delivery; if a reservation
  // exists the external carrier may still be delivering. Recovery must
  // not race with that in-flight delivery.
  if (current.dispatchDeliveryReservation) {
    return { outcome: 'dispatch_reserved', lease: current };
  }

  // ── Recovery: mark holder as unavailable ──
  return {
    outcome: 'recovered',
    lease: recordActionSuccessorOutcome(current, {
      generation: input.expectedGeneration,
      catId: input.holderCatId,
      outcome: 'unavailable',
      evidenceRef: input.evidenceRef,
      now: input.now,
    }),
  };
}
