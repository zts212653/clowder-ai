import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * F245 Phase C PR1b — friction submittedPacket invariant guard.
 *
 * Mirrors capability-wakeup `submitted-packet-guard.ts` + task-outcome
 * `assertSubmittedPacketMatches`. The friction generator uses the cat-submitted
 * packet as the verdict base (Decision 3: submittedPacket required, mirrors
 * task-outcome) and only overrides bundle refs in evidencePacket. This guard
 * enforces generator/domain coherence so a cat cannot publish a friction verdict
 * bound to the wrong domain or feature:
 *   - input.domain.domainId === 'eval:friction'
 *   - submitted.domainId === input.domain.domainId
 *   - submitted.harnessUnderEval.featureId === domain.handoffTargetResolver.featureId (= F245)
 *
 * Newline injection in cat-controlled bullet fields is already rejected by the
 * publish-verdict handler's global `assertNoNewlineInBulletFields`, so this guard
 * stays focused on the domain/feature coherence invariant.
 */
export function assertFrictionSubmittedPacketMatches(
  submitted: VerdictHandoffPacket,
  domain: EvalDomainRegistryEntry,
): void {
  if (domain.domainId !== 'eval:friction') {
    throw new Error(`friction_generator_wrong_domain: input.domain.domainId=${domain.domainId} must be eval:friction`);
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
