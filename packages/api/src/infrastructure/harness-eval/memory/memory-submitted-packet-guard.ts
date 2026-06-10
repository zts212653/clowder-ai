import { BUNDLE_FEATURE_ID_REGEX } from '../a2a/eval-a2a-artifact-resolver.js';
import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import type { MemoryRecallMetrics } from '../eval-memory-adapter.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * F192 publish_verdict eval:memory wire-up — single-entry packet/input guard
 * (mirrors `capability-wakeup/submitted-packet-guard.ts` shape, adapted for
 * memory's cross-feature domain contract).
 *
 * Why a dedicated guard module (refactored after cloud Codex R5→R10 补锅匠
 * cycle): generator was accumulating one ad-hoc check per cloud finding —
 * snapshot/attribution had inconsistent featureId, then regex too loose, then
 * cross-feature blocked, then regex too tight — each cycle added 1 inline
 * check. Single guard module concentrates all packet/input invariants so:
 *   1. Future field additions go in ONE place
 *   2. Generator stays pure-transform (just calls guard, then writes bundle)
 *   3. F-id regex imports `BUNDLE_FEATURE_ID_REGEX` from a2a artifact resolver
 *      = single source of truth (bundle schema). No "guard says yes / bundle
 *      schema says no" drift possible.
 *
 * Guard throws Error with mappable prefix; handler maps to 4xx:
 *   - `no_metrics_in_window:`           → 404 (already mapped)
 *   - `memory_generator_wrong_domain:`  → 500 generator_failed (infrastructure misconfig)
 *   - `invalid_packet_field:`           → 400 (cloud R10 P2 added mapping)
 */

export interface MemorySubmittedPacketGuardInput {
  domain: EvalDomainRegistryEntry;
  recallMetrics: MemoryRecallMetrics;
  submittedPacket: VerdictHandoffPacket;
  windowDays: number;
}

export function assertMemorySubmittedPacket(input: MemorySubmittedPacketGuardInput): void {
  // Infrastructure invariant: route layer should never dispatch a non-memory packet
  // to this generator. Throw 500-shaped error so misconfig surfaces as ops issue.
  if (input.domain.domainId !== 'eval:memory') {
    throw new Error(`memory_generator_wrong_domain: expected eval:memory, got ${input.domain.domainId}`);
  }

  // User-correctable: selector + filters yielded no recall events; clear 404.
  if (input.recallMetrics.totalEvents === 0) {
    throw new Error(
      `no_metrics_in_window: eval:memory selector (windowDays=${input.windowDays}) yielded zero recall events; widen the window or relax filters before publishing`,
    );
  }

  // Packet field invariant: featureId MUST satisfy bundle schema (imported from
  // a2a artifact resolver — single source of truth). Looser regex would let
  // bundle Zod reject later → 500 generator_failed instead of clean 400.
  // Cross-feature handoff is intentionally allowed: packet's featureId wins,
  // regardless of domain default (eval-memory-adapter resolveHandoffFeatureId
  // explicitly designs for F188/orphan-edge-repair → F188).
  if (!BUNDLE_FEATURE_ID_REGEX.test(input.submittedPacket.harnessUnderEval.featureId)) {
    throw new Error(
      `invalid_packet_field: packet.harnessUnderEval.featureId='${input.submittedPacket.harnessUnderEval.featureId}' must match ${BUNDLE_FEATURE_ID_REGEX.source} (bundle schema requires exactly 3 digits — F100..F999)`,
    );
  }
}
