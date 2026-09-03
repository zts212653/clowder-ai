import { type OwnerTruthRefV1, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import type { MeasurementDecisionProofResolver } from '../harness-eval/measurement/measurement-decision-proof-resolver.js';
import type {
  ProgramJoinValidatorOptions,
  ProgramObservationBlocker,
  ProgramObservationBlockerCode,
} from './program-join-validator.js';

type ProgramEvidenceProofResolver = NonNullable<ProgramJoinValidatorOptions['evidenceProofResolver']>;

const MISSING_CODES = {
  evidence_role: 'evidence_role_missing',
  consumer_consumption: 'consumption_proof_missing',
  optimizer_exposure: 'optimizer_exposure_proof_missing',
  promotion_holdout: 'promotion_holdout_missing',
} as const satisfies Record<string, ProgramObservationBlockerCode>;

function blocker(code: ProgramObservationBlockerCode, evidenceProofRef: OwnerTruthRefV1): ProgramObservationBlocker {
  return {
    code,
    ownerFeatureId: 'F267',
    ownerStateRef: evidenceProofRef.ownerStateRef,
  };
}

function unavailable(evidenceProofRef: OwnerTruthRefV1) {
  return {
    status: 'insufficient' as const,
    blockers: [blocker('evidence_owner_contract_unavailable', evidenceProofRef)],
  };
}

function ownerTruthRef(input: { ownerFeatureId: string; ref: string; sha256: string }): OwnerTruthRefV1 | undefined {
  const parsed = ownerTruthRefV1Schema.safeParse({
    ownerFeatureId: input.ownerFeatureId,
    ownerStateRef: input.ref,
    version: input.sha256,
  });
  return parsed.success ? parsed.data : undefined;
}

export function createProgramEvidenceProofResolver(input: {
  decisionProofResolver: MeasurementDecisionProofResolver;
}): ProgramEvidenceProofResolver {
  return async ({ ownerUserId, evidenceProofRef }) => {
    try {
      const resolution = await input.decisionProofResolver.resolve({ ownerUserId, evidenceProofRef });
      if (resolution.status === 'insufficient') return unavailable(evidenceProofRef);

      const proof = resolution.proof;
      if (proof.status === 'insufficient') {
        return {
          status: 'insufficient',
          blockers: [
            ...proof.missingProofs.map((missing) => blocker(MISSING_CODES[missing], evidenceProofRef)),
            ...proof.blockers.map((code) => blocker(code, evidenceProofRef)),
          ],
        };
      }

      if (proof.consumerConsumption.consumerFeatureId !== 'F311') {
        return {
          status: 'insufficient',
          blockers: [blocker('consumption_proof_missing', evidenceProofRef)],
        };
      }

      const evidenceRoleRef = ownerTruthRef(proof.evidenceRole.proof);
      const consumptionProofRef = ownerTruthRef(proof.consumerConsumption.receipt);
      const optimizerExposureProofRef = ownerTruthRef(proof.optimizerExposure.proof);
      const promotionHoldoutRef = ownerTruthRef(proof.promotionHoldout.proof);
      if (!evidenceRoleRef || !consumptionProofRef || !optimizerExposureProofRef || !promotionHoldoutRef) {
        return unavailable(evidenceProofRef);
      }

      return {
        status: 'verified',
        proofRefs: {
          decisionProofRef: evidenceProofRef,
          evidenceRoleRef,
          consumptionProofRef,
          optimizerExposureProofRef,
          promotionHoldoutRef,
        },
      };
    } catch {
      return unavailable(evidenceProofRef);
    }
  };
}
