import {
  type MeasurementDecisionProofOwnerObject,
  MeasurementDecisionProofOwnerObjectSchema,
} from './measurement-decision-proof-owner-object.js';
import type { MeasurementDecisionProofCandidate } from './measurement-decision-proof-schema.js';

type OwnerObjectRef = { ownerFeatureId: string; ref: string; sha256: string };

export interface MeasurementDecisionProofOwnerObjectSpec {
  ref: string;
  sha256: string;
  expected: MeasurementDecisionProofOwnerObject;
}

function ownerObjectSpec(ref: OwnerObjectRef, expected: unknown): MeasurementDecisionProofOwnerObjectSpec {
  return {
    ref: ref.ref,
    sha256: ref.sha256,
    expected: MeasurementDecisionProofOwnerObjectSchema.parse(expected),
  };
}

/** Materialize the exact owner objects a candidate claims, for both issuance and later resolution. */
export function buildMeasurementDecisionProofOwnerObjectSpecs(
  candidate: MeasurementDecisionProofCandidate,
  ownerUserId: string,
): MeasurementDecisionProofOwnerObjectSpec[] {
  const common = {
    kind: 'f267-measurement-decision-proof-owner-object',
    schemaVersion: 1,
    ownerUserId,
  };
  const specs: MeasurementDecisionProofOwnerObjectSpec[] = [];

  if (candidate.evidenceRole) {
    const { proof, ...claim } = candidate.evidenceRole;
    specs.push(
      ownerObjectSpec(proof, {
        ...common,
        objectType: 'evidence_role',
        ownerFeatureId: proof.ownerFeatureId,
        ...claim,
      }),
    );
  }
  if (candidate.layerDiscrimination) {
    const { proof, ...claim } = candidate.layerDiscrimination;
    specs.push(
      ownerObjectSpec(proof, {
        ...common,
        objectType: 'layer_discrimination',
        ownerFeatureId: proof.ownerFeatureId,
        ...claim,
      }),
    );
  }
  if (candidate.interventionCard) {
    const { proof, ...claim } = candidate.interventionCard;
    specs.push(
      ownerObjectSpec(proof, {
        ...common,
        objectType: 'intervention_card',
        ownerFeatureId: proof.ownerFeatureId,
        ...claim,
      }),
    );
  }
  if (candidate.consumerConsumption) {
    const { receipt, ...claim } = candidate.consumerConsumption;
    specs.push(
      ownerObjectSpec(receipt, {
        ...common,
        objectType: 'consumer_consumption',
        ownerFeatureId: receipt.ownerFeatureId,
        ...claim,
      }),
    );
  }
  if (candidate.optimizerExposure) {
    const { proof, ...claim } = candidate.optimizerExposure;
    specs.push(
      ownerObjectSpec(proof, {
        ...common,
        objectType: 'optimizer_exposure',
        ownerFeatureId: proof.ownerFeatureId,
        ...claim,
      }),
    );
  }
  if (candidate.promotionHoldout) {
    const holdout = candidate.promotionHoldout;
    specs.push(
      ownerObjectSpec(
        {
          ownerFeatureId: holdout.proof.ownerFeatureId,
          ref: holdout.cohortRef,
          sha256: holdout.cohortSha256,
        },
        {
          ...common,
          objectType: 'promotion_holdout_cohort',
          ownerFeatureId: holdout.proof.ownerFeatureId,
          cohortRef: holdout.cohortRef,
          window: holdout.window,
        },
      ),
    );
    const { proof, ...claim } = holdout;
    specs.push(
      ownerObjectSpec(proof, {
        ...common,
        objectType: 'promotion_holdout',
        ownerFeatureId: proof.ownerFeatureId,
        ...claim,
      }),
    );
    if (holdout.independence.kind === 'sealed') {
      const { seal, sealedAtMs, optimizerSelectionCutoffMs } = holdout.independence;
      specs.push(
        ownerObjectSpec(seal, {
          ...common,
          objectType: 'promotion_holdout_seal',
          ownerFeatureId: seal.ownerFeatureId,
          cohortRef: holdout.cohortRef,
          cohortSha256: holdout.cohortSha256,
          sealedAtMs,
          optimizerSelectionCutoffMs,
        }),
      );
    }
  }
  return specs;
}
