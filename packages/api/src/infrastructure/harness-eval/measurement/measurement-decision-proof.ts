import type { MeasurementBundleCertificate, MeasurementBundleResult } from './measurement-bundle-schema.js';
import { parseMeasurementBundleCertificate, validateMeasurementBundleResult } from './measurement-bundle-validation.js';
import {
  DECISION_PROOF_WITHDRAWAL_BY_BLOCKER,
  DECISION_PROOF_WITHDRAWAL_BY_MISSING,
  type DecisionProofBlocker,
  type DecisionProofMissing,
  type MeasurementDecisionProofCandidate,
  type MeasurementDecisionProofCandidateAssessment,
  MeasurementDecisionProofCandidateAssessmentSchema,
  MeasurementDecisionProofCandidateSchema,
} from './measurement-decision-proof-schema.js';

export type {
  MeasurementDecisionProofCandidate,
  MeasurementDecisionProofCandidateAssessment,
} from './measurement-decision-proof-schema.js';
export {
  MeasurementDecisionProofCandidateAssessmentSchema,
  MeasurementDecisionProofCandidateSchema,
} from './measurement-decision-proof-schema.js';

function assertSubjectIdentity(
  certificate: MeasurementBundleCertificate,
  result: MeasurementBundleResult,
  candidate: MeasurementDecisionProofCandidate,
): void {
  const subject = candidate.subject;
  if (
    subject.certificateId !== certificate.certificateId ||
    subject.certificateRef !== result.certificateRef ||
    subject.resultId !== result.resultId ||
    subject.evaluationCohortRef !== result.cohort.ref ||
    subject.evaluationCohortSha256 !== result.cohort.sha256
  ) {
    throw new Error('decision proof subject does not match its certificate, result, and evaluation cohort');
  }
}

function assertProofBindings(
  certificate: MeasurementBundleCertificate,
  result: MeasurementBundleResult,
  candidate: MeasurementDecisionProofCandidate,
): void {
  const consumption = candidate.consumerConsumption;
  if (
    consumption &&
    (consumption.consumerFeatureId !== certificate.decision.consumerFeatureId ||
      consumption.consumerOwnerCatId !== certificate.decision.consumerOwnerCatId ||
      consumption.resultId !== result.resultId ||
      consumption.receipt.ownerFeatureId !== consumption.consumerFeatureId)
  ) {
    throw new Error('consumer consumption does not match the named certificate consumer and result');
  }

  const evidenceRole = candidate.evidenceRole;
  if (
    evidenceRole &&
    (evidenceRole.cohortRef !== result.cohort.ref || evidenceRole.cohortSha256 !== result.cohort.sha256)
  ) {
    throw new Error('evidence role does not match the evaluation cohort');
  }

  // Discrimination is a claim about THIS cohort's evidence. A claim bound to some other cohort would
  // let a well-separated experiment vouch for the layers of an unrelated one.
  const discrimination = candidate.layerDiscrimination;
  if (
    discrimination &&
    (discrimination.cohortRef !== result.cohort.ref || discrimination.cohortSha256 !== result.cohort.sha256)
  ) {
    throw new Error('layer discrimination does not match the evaluation cohort');
  }

  const exposure = candidate.optimizerExposure;
  if (exposure && (exposure.cohortRef !== result.cohort.ref || exposure.cohortSha256 !== result.cohort.sha256)) {
    throw new Error('optimizer exposure does not match the evaluation cohort');
  }
}

function collectMissingProofs(candidate: MeasurementDecisionProofCandidate): DecisionProofMissing[] {
  const missing: DecisionProofMissing[] = [];
  if (!candidate.evidenceRole) missing.push('evidence_role');
  if (!candidate.consumerConsumption) missing.push('consumer_consumption');
  if (!candidate.optimizerExposure) missing.push('optimizer_exposure');
  if (!candidate.promotionHoldout) missing.push('promotion_holdout');
  return missing;
}

function collectPromotionBlockers(
  result: MeasurementBundleResult,
  candidate: MeasurementDecisionProofCandidate,
): DecisionProofBlocker[] {
  const holdout = candidate.promotionHoldout;
  if (!holdout) return [];

  const blockers: DecisionProofBlocker[] = [];
  if (holdout.cohortRef === result.cohort.ref || holdout.cohortSha256 === result.cohort.sha256) {
    blockers.push('promotion_holdout_reuses_evaluation_cohort');
  }
  if (
    holdout.optimizerExposure.candidateSelection !== 'not_exposed' ||
    holdout.optimizerExposure.rubricSelection !== 'not_exposed'
  ) {
    blockers.push('promotion_holdout_optimizer_exposed');
  }
  if (
    holdout.independence.kind === 'sealed' &&
    holdout.independence.sealedAtMs >= holdout.independence.optimizerSelectionCutoffMs
  ) {
    blockers.push('promotion_holdout_not_sealed');
  }
  if (
    holdout.independence.kind === 'time_fresh' &&
    holdout.window.startMs <= holdout.independence.optimizerSelectionCutoffMs
  ) {
    blockers.push('promotion_holdout_not_time_fresh');
  }
  return blockers;
}

export function assessMeasurementDecisionProofCandidate(
  certificateInput: unknown,
  resultInput: unknown,
  candidateInput: unknown,
): MeasurementDecisionProofCandidateAssessment {
  const certificate = parseMeasurementBundleCertificate(certificateInput);
  const result = validateMeasurementBundleResult(certificate, resultInput);
  const candidate = MeasurementDecisionProofCandidateSchema.parse(candidateInput);
  assertSubjectIdentity(certificate, result, candidate);
  assertProofBindings(certificate, result, candidate);

  const { kind: _candidateKind, schemaVersion: _candidateVersion, subject, ...payload } = candidate;
  const common = {
    kind: 'f267-measurement-decision-proof-candidate-assessment' as const,
    schemaVersion: 1 as const,
    ...payload,
    subject: {
      ...subject,
      measurementDecisionStatus: result.decision.status,
    },
  };
  const missingProofs = collectMissingProofs(candidate);
  const blockers = collectPromotionBlockers(result, candidate);

  if (missingProofs.length === 0 && blockers.length === 0) {
    return MeasurementDecisionProofCandidateAssessmentSchema.parse({
      ...common,
      status: 'candidate_sufficient',
    });
  }

  return MeasurementDecisionProofCandidateAssessmentSchema.parse({
    ...common,
    status: 'candidate_insufficient',
    missingProofs,
    blockers,
    withdrawalConditions: [
      ...missingProofs.map((proof) => DECISION_PROOF_WITHDRAWAL_BY_MISSING[proof]),
      ...blockers.map((blocker) => DECISION_PROOF_WITHDRAWAL_BY_BLOCKER[blocker]),
    ],
  });
}
