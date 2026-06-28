import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * F236 Track-2 — anchor-first submittedPacket invariant guard.
 *
 * Mirrors friction `assertFrictionSubmittedPacketMatches` and capability-wakeup
 * `assertSubmittedPacketMatches`. Enforces generator/domain coherence so a cat
 * cannot publish an anchor-first verdict bound to the wrong domain or feature:
 *   - input.domain.domainId === 'eval:anchor-first'
 *   - submitted.domainId === input.domain.domainId
 *   - submitted.harnessUnderEval.featureId === domain.handoffTargetResolver.featureId
 *
 * Cloud R3 P2: added to fail closed on domainId/featureId mismatch.
 */
export function assertAnchorSubmittedPacketMatches(
  submitted: VerdictHandoffPacket,
  domain: EvalDomainRegistryEntry,
): void {
  if (domain.domainId !== 'eval:anchor-first') {
    throw new Error(
      `anchor_generator_wrong_domain: input.domain.domainId=${domain.domainId} must be eval:anchor-first`,
    );
  }
  if (submitted.domainId !== domain.domainId) {
    throw new Error(
      `submitted_packet_evidence_mismatch: packet.domainId=${submitted.domainId} vs input.domain.domainId=${domain.domainId}`,
    );
  }
  const expectedFid = domain.handoffTargetResolver.featureId;
  if (submitted.harnessUnderEval.featureId !== expectedFid) {
    throw new Error(
      `submitted_packet_evidence_mismatch: packet.harnessUnderEval.featureId=${submitted.harnessUnderEval.featureId} vs domain.handoffTargetResolver.featureId=${expectedFid}`,
    );
  }
}
