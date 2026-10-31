import type { EvalDomainRegistryEntry } from '../domain/eval-domain-registry.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';
import type { CapabilityName } from './eval-capability-wakeup-adapter.js';

/**
 * 砚砚 R8 P1 (a2a mirror) + R2 P1 + cloud R3 P2: when cat-mediated publish supplies
 * submittedPacket, generator uses it as base (NOT regenerate). The build-from-trials
 * path enforces invariants via `buildCapabilityWakeupVerdictHandoff` — submittedPacket
 * path MUST mirror them, else cat-mediated publish degrades safety vs operator-regen.
 *
 * Invariants enforced:
 * - input.domain.domainId === 'eval:capability-wakeup' (mirrors verdict.ts:20-22;
 *   cloud R3 P2: WITHOUT this, wrong-generator routing — input.domain=eval:a2a — slips
 *   through when submitted.domainId === domain.domainId, yet generator hard-codes
 *   eval:capability-wakeup in frontmatter while packet carries the other domain)
 * - submittedPacket.harnessUnderEval.featureId === domain.handoffTargetResolver.featureId
 * - submittedPacket.domainId === input.domain.domainId
 * - submittedPacket.harnessUnderEval.componentId === input.capability
 *   (R2: WITHOUT this, cat can publish `workspace-navigator` verdict bound to
 *   `rich-messaging` evidence bundle — silently cross-contaminates Hub view)
 */
export function assertSubmittedPacketMatches(
  submitted: VerdictHandoffPacket | undefined,
  domain: EvalDomainRegistryEntry,
  capability: CapabilityName,
): void {
  if (!submitted) return;
  // cloud R3 P2: mirror buildCapabilityWakeupVerdictHandoff:20-22 invariant on
  // submittedPacket path — generator-domain coherence must not depend on caller correctness.
  if (domain.domainId !== 'eval:capability-wakeup') {
    throw new Error(
      `capability_wakeup_generator_wrong_domain: input.domain.domainId=${domain.domainId} must be eval:capability-wakeup (submittedPacket path mirrors buildCapabilityWakeupVerdictHandoff invariant)`,
    );
  }
  const expectedFid = domain.handoffTargetResolver.featureId;
  if (submitted.harnessUnderEval.featureId !== expectedFid) {
    throw new Error(
      `submitted_packet_evidence_mismatch: packet.harnessUnderEval.featureId=${submitted.harnessUnderEval.featureId} vs domain.handoffTargetResolver.featureId=${expectedFid}`,
    );
  }
  if (submitted.domainId !== domain.domainId) {
    throw new Error(
      `submitted_packet_evidence_mismatch: packet.domainId=${submitted.domainId} vs input.domain.domainId=${domain.domainId}`,
    );
  }
  if (submitted.harnessUnderEval.componentId !== capability) {
    throw new Error(
      `submitted_packet_evidence_mismatch: packet.harnessUnderEval.componentId=${submitted.harnessUnderEval.componentId} vs input.capability=${capability}`,
    );
  }
  // cloud R4 P2 (real finding): cat-controlled strings rendered into single-line markdown bullets
  // allow `value\n- snapshot:forged` injection — Hub read-model would parse the spoofed bullet as
  // real evidence. `formatLiveVerdictMarkdown` exposes 3 cat-controlled fields:
  //   • phenomenon (line ~270)
  //   • ownerAsk.requestedAction (line ~272)
  //   • evidencePacket.metricRefs[] (line ~280)
  // snapshotRefs/attributionRefs are overwritten by tool-resolved bundle refs (live-verdict.ts:113-114),
  // so they're not cat-controlled at render time and need no guard here.
  // The publish-verdict handler has a global newline guard, but this exported generator can be called
  // directly — defense in depth at the gate, not at the handler.
  assertNoNewline(submitted.phenomenon, 'phenomenon');
  assertNoNewline(submitted.ownerAsk.requestedAction, 'ownerAsk.requestedAction');
  for (let i = 0; i < submitted.evidencePacket.metricRefs.length; i++) {
    assertNoNewline(submitted.evidencePacket.metricRefs[i], `evidencePacket.metricRefs[${i}]`);
  }
}

const NEWLINE_REGEX = /[\r\n]/;
function assertNoNewline(value: string, fieldName: string): void {
  if (NEWLINE_REGEX.test(value)) {
    throw new Error(
      `submitted_packet_newline_injection: ${fieldName} contains CR/LF — would inject spoofed markdown bullets into Hub-visible verdict.md`,
    );
  }
}
