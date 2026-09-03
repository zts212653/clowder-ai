import { type AssetVersionRefV1, type OwnerTruthRefV1, refIdentity } from '@cat-cafe/shared';
import {
  EvolutionProgramEvaluationError,
  type OwnerMeasurementBundle,
  type ProgramAttributionLinkInput,
  type ProgramEvaluationDependencies,
  type ProgramMeasurementLinkInput,
} from './program-evaluation-contract.js';
import type { EvolutionProgramProjectionV1 } from './program-projection.js';

/**
 * Everything the ingress must obtain from the owner, or refuse.
 *
 * These are the checks that keep a well-shaped request from becoming a verdict: the owner must be
 * reachable, the evidence must belong to THIS Program's constitution, the candidate evidence must be
 * something Phase 2 actually connected, and the canonical identities must exist rather than being
 * substituted with whatever ref happens to be at hand.
 */

/**
 * Fail closed when the owner contract is unavailable. Accepting the caller's word here is the whole
 * hazard: without F267 there is no measurement verdict, and "no verdict" is not "usable".
 */
export async function requireOwnerBundle(
  input: ProgramMeasurementLinkInput,
  deps: ProgramEvaluationDependencies,
  projection?: EvolutionProgramProjectionV1,
): Promise<OwnerMeasurementBundle> {
  if (!deps.ownerResolver) {
    throw new EvolutionProgramEvaluationError(
      'owner_evidence_unavailable',
      'F267 measurement owner contract is not available; the Program cannot evaluate on caller-supplied claims',
    );
  }
  const resolution = await deps.ownerResolver.resolveMeasurement({
    ownerUserId: input.ownerUserId,
    evidenceProofRef: input.evidenceProofRef,
  });
  if (resolution.status !== 'ready') {
    throw new EvolutionProgramEvaluationError(
      'owner_evidence_unavailable',
      `owner measurement evidence unavailable: ${resolution.reason}`,
    );
  }
  const bundle = resolution.bundle;
  // The evidence must belong to THIS Program's constitution. Otherwise a valid proof for some other
  // Program's certificate would be enough to drive this one.
  const constituted = projection?.program.certificates.measurement;
  if (bundle.certificateRef !== undefined && constituted !== undefined) {
    if (refIdentity(bundle.certificateRef) !== refIdentity(constituted)) {
      throw new EvolutionProgramEvaluationError(
        'invalid_request',
        "the owner proof is bound to another Program's measurement certificate",
      );
    }
  }
  return bundle;
}

/**
 * Candidate evidence must be something this Program already connected through Phase 2 — an owner
 * surface or the canonical trajectory. A caller-invented `inv:FAKE` is not evidence.
 */
export function requireLinkedEvidence(
  candidates: ProgramAttributionLinkInput['candidates'],
  projection: EvolutionProgramProjectionV1,
): void {
  const linked = new Set<string>();
  const trajectory = projection.observation.trajectory;
  if (trajectory) linked.add(refIdentity(trajectory.ref));
  for (const eye of projection.observation.connectedEyes) linked.add(refIdentity(eye.ownerSurfaceRef));
  for (const candidate of candidates) {
    for (const ref of candidate.evidenceRefs) {
      if (!linked.has(refIdentity(ref))) {
        throw new EvolutionProgramEvaluationError(
          'invalid_request',
          `attribution evidence ${ref.ownerStateRef} is not an owner surface this Program connected`,
        );
      }
    }
  }
}

/**
 * A proof's identity is not a measurement result's identity. F267 publishes both as canonical owner
 * refs, but if a resolution ever arrives without them there is nothing honest to persist, so we
 * refuse rather than append a `measurement_linked` whose refs mean something they do not.
 */
export function requireCanonicalSubject(bundle: OwnerMeasurementBundle): {
  certificateRef: OwnerTruthRefV1;
  resultRef: OwnerTruthRefV1;
} {
  if (bundle.certificateRef === undefined || bundle.resultRef === undefined) {
    throw new EvolutionProgramEvaluationError(
      'owner_evidence_unavailable',
      'the owner published no canonical certificate/result refs for this proof; the Program will not persist a proof ref in their place',
    );
  }
  return { certificateRef: bundle.certificateRef, resultRef: bundle.resultRef };
}

export const measurementJoinInput = (input: ProgramMeasurementLinkInput, bundle: OwnerMeasurementBundle) => ({
  decisionProofRef: input.evidenceProofRef,
  certificateRef: requireCanonicalSubject(bundle).certificateRef,
  measurementResultRef: requireCanonicalSubject(bundle).resultRef,
  ownerDecisionStatus: bundle.ownerDecisionStatus,
  ...(bundle.frozenCohortRef === undefined ? {} : { frozenCohortRef: bundle.frozenCohortRef }),
  ...(bundle.baselineRef === undefined ? {} : { baselineRef: bundle.baselineRef }),
  ...(bundle.exposureProofRef === undefined ? {} : { exposureProofRef: bundle.exposureProofRef }),
  ...(bundle.discriminationProofRef === undefined ? {} : { discriminationProofRef: bundle.discriminationProofRef }),
  // Persisting the ruler is what lets the NEXT round ask "did it move" against owner truth.
  ...(bundle.rubricRef === undefined ? {} : { rubricRef: bundle.rubricRef }),
  ...(bundle.uncertainty === undefined ? {} : { uncertainty: bundle.uncertainty }),
});
