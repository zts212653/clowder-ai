import {
  type AssetVersionRefV1,
  type EvolutionProgramEventV1,
  type OwnerTruthRefV1,
  refIdentity,
} from '@cat-cafe/shared';
import {
  CONTROL_PLANE_FEATURE_ID,
  collectForeignOwnership,
  type EvolutionEvalReason,
  evalReason,
} from './eval-reasons.js';
import type { RubricComparabilityAssessment } from './rubric-comparability.js';

export * from './eval-reasons.js';
export * from './rubric-comparability.js';

/**
 * F311 Phase 3 — ref-only join into the F192/F267 measurement plane (AC-31).
 *
 * This bridge never stores rubric text, cohort rows, verdict payloads or intervention cards. It
 * reads owner refs plus the owner's own typed verdict, and it fails closed: when owner-backed
 * evidence is absent, contaminated or incomparable, the Program says `insufficient` /
 * `unresolved` / `incomparable` instead of inventing a conclusion.
 */

export const EVOLUTION_ATTRIBUTION_LAYERS = ['execution', 'harness', 'rubric', 'observation'] as const;
export type EvolutionAttributionLayer = (typeof EVOLUTION_ATTRIBUTION_LAYERS)[number];

export type MeasurementUncertaintyBasis = 'interval' | 'power' | 'not_estimable';

export interface MeasurementJoinInput {
  /**
   * The F267 decision proof this round consumed. Persisted into lineage because after a restart the
   * stream must still answer "which decision proof was this measurement read out of" — without it the
   * audit trail stops at the result and the proof that authorised reading it is unrecoverable.
   */
  decisionProofRef: OwnerTruthRefV1;
  certificateRef: OwnerTruthRefV1;
  measurementResultRef: OwnerTruthRefV1;
  /** F267 owns the verdict; F311 routes on it and never re-decides it. */
  ownerDecisionStatus: 'usable' | 'insufficient';
  frozenCohortRef?: OwnerTruthRefV1;
  baselineRef?: OwnerTruthRefV1;
  exposureProofRef?: OwnerTruthRefV1;
  /** The owner object behind the discrimination claim, so the claim itself stays auditable. */
  discriminationProofRef?: OwnerTruthRefV1;
  /** The ruler this measurement was scored with, as declared by the owner's certificate. */
  rubricRef?: AssetVersionRefV1;
  uncertainty?: { evidenceRef: OwnerTruthRefV1; basis: MeasurementUncertaintyBasis };
}

export interface MeasurementJoinAssessment {
  validity: 'valid' | 'insufficient';
  reasons: EvolutionEvalReason[];
  uncertaintyBasis?: MeasurementUncertaintyBasis;
  uncertaintyEvidenceRef?: OwnerTruthRefV1;
  evidenceRefs: OwnerTruthRefV1[];
  event: Extract<EvolutionProgramEventV1, { type: 'measurement_linked' }>;
}

export interface AttributionCandidateInput {
  layer: EvolutionAttributionLayer;
  evidenceRefs: OwnerTruthRefV1[];
  /** Owner-declared: does this evidence separate this layer from the other three? */
  discriminating: boolean;
}

export interface AttributionInput {
  programId: string;
  cycle: number;
  measurement: MeasurementJoinAssessment;
  comparability: RubricComparabilityAssessment;
  candidates: AttributionCandidateInput[];
}

export interface AttributionAssessment {
  verdict: 'attributed' | 'unresolved' | 'insufficient' | 'incomparable';
  primaryLayer?: EvolutionAttributionLayer;
  competingLayers: EvolutionAttributionLayer[];
  assessedLayers: EvolutionAttributionLayer[];
  /** Layers with no evidence this round: "nobody looked", never "ruled out". */
  notAssessedLayers: EvolutionAttributionLayer[];
  disposition: 'intervention_candidate' | 'no_intervention';
  reasons: EvolutionEvalReason[];
  evidenceRefs: OwnerTruthRefV1[];
  measurement: MeasurementJoinAssessment;
  comparability: RubricComparabilityAssessment;
  event: Extract<EvolutionProgramEventV1, { type: 'attribution_linked' }>;
}

export function assessMeasurementJoin(input: MeasurementJoinInput): MeasurementJoinAssessment {
  const reasons: EvolutionEvalReason[] = collectForeignOwnership([
    ['decision proof', input.decisionProofRef],
    ['measurement certificate', input.certificateRef],
    ['measurement result', input.measurementResultRef],
    ['frozen cohort', input.frozenCohortRef],
    ['baseline', input.baselineRef],
    ['exposure proof', input.exposureProofRef],
    ['layer discrimination proof', input.discriminationProofRef],
    ['uncertainty evidence', input.uncertainty?.evidenceRef],
  ]);

  if (input.ownerDecisionStatus === 'insufficient') {
    reasons.push(evalReason('owner_declared_insufficient', input.measurementResultRef));
  }
  if (input.frozenCohortRef === undefined) {
    reasons.push(evalReason('frozen_cohort_missing'));
  }
  if (input.baselineRef === undefined) {
    reasons.push(evalReason('baseline_missing'));
  }
  if (input.exposureProofRef === undefined) {
    reasons.push(evalReason('exposure_proof_missing'));
  }
  if (input.uncertainty === undefined) {
    reasons.push(evalReason('uncertainty_evidence_missing'));
  } else if (input.uncertainty.basis === 'not_estimable') {
    reasons.push(evalReason('uncertainty_not_estimable', input.uncertainty.evidenceRef));
  }

  const validity = reasons.length === 0 ? 'valid' : 'insufficient';
  const evidenceRefs = [
    input.decisionProofRef,
    input.certificateRef,
    input.measurementResultRef,
    input.frozenCohortRef,
    input.baselineRef,
    input.exposureProofRef,
    input.discriminationProofRef,
    input.rubricRef,
    input.uncertainty?.evidenceRef,
  ].filter((ref): ref is OwnerTruthRefV1 => ref !== undefined);

  return {
    validity,
    reasons,
    ...(input.uncertainty === undefined
      ? {}
      : { uncertaintyBasis: input.uncertainty.basis, uncertaintyEvidenceRef: input.uncertainty.evidenceRef }),
    evidenceRefs,
    event: {
      type: 'measurement_linked',
      measurementResultRef: input.measurementResultRef,
      validity,
      // Persist the reason, not only the flag: the surface must not have to guess after a restart.
      reasonCodes: [...new Set(reasons.map((entry) => entry.code))].slice(0, 32),
      evidenceRefs,
      uncertaintyBasis: input.uncertainty?.basis ?? 'unknown',
      ...(input.rubricRef === undefined ? {} : { rubricRef: input.rubricRef }),
    },
  };
}

function partitionCandidates(candidates: readonly AttributionCandidateInput[]): {
  assessed: AttributionCandidateInput[];
  reasons: EvolutionEvalReason[];
} {
  const reasons: EvolutionEvalReason[] = [];
  const assessed: AttributionCandidateInput[] = [];
  for (const layer of EVOLUTION_ATTRIBUTION_LAYERS) {
    const candidate = candidates.find((entry) => entry.layer === layer);
    if (candidate === undefined) continue;
    const owned = candidate.evidenceRefs.filter((ref) => ref.ownerFeatureId !== CONTROL_PLANE_FEATURE_ID);
    if (owned.length !== candidate.evidenceRefs.length) {
      reasons.push(evalReason('f311_cannot_own_evidence', undefined, `${layer} 层`));
    }
    if (owned.length === 0) {
      reasons.push(evalReason('attribution_candidate_without_evidence', undefined, `${layer} 层`));
      continue;
    }
    assessed.push({ ...candidate, evidenceRefs: owned });
  }
  return { assessed, reasons };
}

export function resolveAttribution(input: AttributionInput): AttributionAssessment {
  const { assessed, reasons } = partitionCandidates(input.candidates);
  const assessedLayers = assessed.map((candidate) => candidate.layer);
  const notAssessedLayers = EVOLUTION_ATTRIBUTION_LAYERS.filter((layer) => !assessedLayers.includes(layer));
  const discriminating = assessed.filter((candidate) => candidate.discriminating);
  const evidenceRefs = [
    ...input.measurement.evidenceRefs,
    ...input.comparability.evidenceRefs,
    ...assessed.flatMap((candidate) => candidate.evidenceRefs),
  ];

  let verdict: AttributionAssessment['verdict'];
  let primaryLayer: EvolutionAttributionLayer | undefined;
  if (input.measurement.validity === 'insufficient') {
    verdict = 'insufficient';
    reasons.push(evalReason('measurement_insufficient'));
  } else if (input.comparability.comparability === 'incomparable') {
    verdict = 'incomparable';
    reasons.push(evalReason('comparison_incomparable'));
  } else if (discriminating.length === 1) {
    verdict = 'attributed';
    primaryLayer = discriminating[0]?.layer;
  } else {
    verdict = 'unresolved';
    reasons.push(
      discriminating.length === 0 ? evalReason('no_discriminating_evidence') : evalReason('competing_layers_tied'),
    );
  }

  const disposition = verdict === 'attributed' ? 'intervention_candidate' : 'no_intervention';
  // Full identity: two rubric versions are two pieces of evidence, not one.
  const uniqueEvidenceRefs = [...new Map(evidenceRefs.map((ref) => [refIdentity(ref), ref])).values()];
  return {
    verdict,
    ...(primaryLayer === undefined ? {} : { primaryLayer }),
    competingLayers: discriminating.map((candidate) => candidate.layer),
    assessedLayers,
    notAssessedLayers: [...notAssessedLayers],
    disposition,
    reasons,
    evidenceRefs,
    measurement: input.measurement,
    comparability: input.comparability,
    event: {
      // The diagnosis is the Program's own orchestration record (derived, payload-free); every
      // fact it stands on stays in the owner refs collected above.
      type: 'attribution_linked',
      attributionRef: {
        ownerFeatureId: CONTROL_PLANE_FEATURE_ID,
        ownerStateRef: `evolution-attribution:${input.programId}:${input.cycle}`,
      },
      disposition,
      // Durable typed snapshot: enums, codes and owner refs only, so AC-34 survives restart/replay.
      // `notAssessedLayers` is never stored — it is derived, so "nobody looked" cannot drift into
      // a persisted claim of "ruled out".
      diagnosis: {
        verdict,
        ...(primaryLayer === undefined ? {} : { primaryLayer }),
        assessedLayers,
        competingLayers: discriminating.map((candidate) => candidate.layer),
        evidenceRefs: uniqueEvidenceRefs,
        uncertaintyBasis: input.measurement.uncertaintyBasis ?? 'unknown',
        comparabilityMode: input.comparability.mode,
        comparabilityStatus: input.comparability.comparability,
        // Union across the three planes, so the surface can explain the whole "why", not just the last step.
        reasonCodes: [
          ...new Set(
            [...input.measurement.reasons, ...input.comparability.reasons, ...reasons].map((entry) => entry.code),
          ),
        ].slice(0, 32),
      },
    },
  };
}
