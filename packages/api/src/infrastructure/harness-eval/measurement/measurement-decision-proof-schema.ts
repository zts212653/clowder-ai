import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const featureId = z.string().regex(/^F\d{3}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256');
const exposureState = z.enum(['exposed', 'not_exposed']);

export const DecisionProofMissingSchema = z.enum([
  'evidence_role',
  'consumer_consumption',
  'optimizer_exposure',
  'promotion_holdout',
]);
export const DecisionProofBlockerSchema = z.enum([
  'promotion_holdout_reuses_evaluation_cohort',
  'promotion_holdout_optimizer_exposed',
  'promotion_holdout_not_sealed',
  'promotion_holdout_not_time_fresh',
]);
export const DecisionProofWithdrawalConditionSchema = z.enum([
  'attach_owner_backed_evidence_role_proof',
  'attach_named_consumer_consumption_receipt',
  'attach_optimizer_exposure_proof',
  'attach_independent_sealed_or_time_fresh_promotion_holdout',
  'issue_a_distinct_promotion_holdout',
  'issue_a_holdout_unexposed_to_candidate_and_rubric_selection',
  'seal_the_holdout_before_optimizer_selection',
  'collect_the_holdout_after_optimizer_selection_closes',
]);

export type DecisionProofMissing = z.infer<typeof DecisionProofMissingSchema>;
export type DecisionProofBlocker = z.infer<typeof DecisionProofBlockerSchema>;
type DecisionProofWithdrawalCondition = z.infer<typeof DecisionProofWithdrawalConditionSchema>;

export const DECISION_PROOF_WITHDRAWAL_BY_MISSING: Record<DecisionProofMissing, DecisionProofWithdrawalCondition> = {
  evidence_role: 'attach_owner_backed_evidence_role_proof',
  consumer_consumption: 'attach_named_consumer_consumption_receipt',
  optimizer_exposure: 'attach_optimizer_exposure_proof',
  promotion_holdout: 'attach_independent_sealed_or_time_fresh_promotion_holdout',
};

export const DECISION_PROOF_WITHDRAWAL_BY_BLOCKER: Record<DecisionProofBlocker, DecisionProofWithdrawalCondition> = {
  promotion_holdout_reuses_evaluation_cohort: 'issue_a_distinct_promotion_holdout',
  promotion_holdout_optimizer_exposed: 'issue_a_holdout_unexposed_to_candidate_and_rubric_selection',
  promotion_holdout_not_sealed: 'seal_the_holdout_before_optimizer_selection',
  promotion_holdout_not_time_fresh: 'collect_the_holdout_after_optimizer_selection_closes',
};

import {
  ConsumerConsumptionProofSchema,
  DecisionProofSubjectSchema,
  EvidenceRoleProofSchema,
  InterventionCardProofSchema,
  LayerDiscriminationProofSchema,
  OptimizerExposureProofSchema,
  PromotionHoldoutProofSchema,
} from './measurement-decision-proof-elements.js';

const candidatePayload = {
  proofId: nonEmpty,
  generatedAt: z.string().datetime(),
  subject: DecisionProofSubjectSchema,
  evidenceRole: EvidenceRoleProofSchema.optional(),
  layerDiscrimination: LayerDiscriminationProofSchema.optional(),
  interventionCard: InterventionCardProofSchema.optional(),
  consumerConsumption: ConsumerConsumptionProofSchema.optional(),
  optimizerExposure: OptimizerExposureProofSchema.optional(),
  promotionHoldout: PromotionHoldoutProofSchema.optional(),
};

export const MeasurementDecisionProofCandidateSchema = z
  .object({
    kind: z.literal('f267-measurement-decision-proof-candidate'),
    schemaVersion: z.literal(1),
    ...candidatePayload,
  })
  .strict();

export const MeasurementDecisionProofRecordSchema = z
  .object({
    kind: z.literal('f267-measurement-decision-proof-record'),
    schemaVersion: z.literal(1),
    proofRef: nonEmpty,
    ownerUserId: nonEmpty,
    candidate: MeasurementDecisionProofCandidateSchema,
  })
  .strict();

const assessedPayload = {
  proofId: nonEmpty,
  generatedAt: z.string().datetime(),
  subject: DecisionProofSubjectSchema.extend({
    measurementDecisionStatus: z.enum(['usable', 'insufficient']),
  }).strict(),
};

const candidateAssessmentUnion = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('f267-measurement-decision-proof-candidate-assessment'),
      schemaVersion: z.literal(1),
      status: z.literal('candidate_sufficient'),
      ...assessedPayload,
      evidenceRole: EvidenceRoleProofSchema,
      layerDiscrimination: LayerDiscriminationProofSchema.optional(),
      interventionCard: InterventionCardProofSchema.optional(),
      consumerConsumption: ConsumerConsumptionProofSchema,
      optimizerExposure: OptimizerExposureProofSchema,
      promotionHoldout: PromotionHoldoutProofSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('f267-measurement-decision-proof-candidate-assessment'),
      schemaVersion: z.literal(1),
      status: z.literal('candidate_insufficient'),
      ...assessedPayload,
      evidenceRole: EvidenceRoleProofSchema.optional(),
      layerDiscrimination: LayerDiscriminationProofSchema.optional(),
      interventionCard: InterventionCardProofSchema.optional(),
      consumerConsumption: ConsumerConsumptionProofSchema.optional(),
      optimizerExposure: OptimizerExposureProofSchema.optional(),
      promotionHoldout: PromotionHoldoutProofSchema.optional(),
      missingProofs: z.array(DecisionProofMissingSchema),
      blockers: z.array(DecisionProofBlockerSchema),
      withdrawalConditions: z.array(DecisionProofWithdrawalConditionSchema).min(1),
    })
    .strict(),
]);

const measurementDecisionProofUnion = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('f267-measurement-decision-proof'),
      schemaVersion: z.literal(1),
      status: z.literal('verified'),
      ...assessedPayload,
      evidenceRole: EvidenceRoleProofSchema,
      layerDiscrimination: LayerDiscriminationProofSchema.optional(),
      interventionCard: InterventionCardProofSchema.optional(),
      consumerConsumption: ConsumerConsumptionProofSchema,
      optimizerExposure: OptimizerExposureProofSchema,
      promotionHoldout: PromotionHoldoutProofSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('f267-measurement-decision-proof'),
      schemaVersion: z.literal(1),
      status: z.literal('insufficient'),
      ...assessedPayload,
      evidenceRole: EvidenceRoleProofSchema.optional(),
      layerDiscrimination: LayerDiscriminationProofSchema.optional(),
      interventionCard: InterventionCardProofSchema.optional(),
      consumerConsumption: ConsumerConsumptionProofSchema.optional(),
      optimizerExposure: OptimizerExposureProofSchema.optional(),
      promotionHoldout: PromotionHoldoutProofSchema.optional(),
      missingProofs: z.array(DecisionProofMissingSchema),
      blockers: z.array(DecisionProofBlockerSchema),
      withdrawalConditions: z.array(DecisionProofWithdrawalConditionSchema).min(1),
    })
    .strict(),
]);

function validateInsufficientDeficiencies(
  proof: {
    missingProofs: DecisionProofMissing[];
    blockers: DecisionProofBlocker[];
    withdrawalConditions: DecisionProofWithdrawalCondition[];
  },
  context: z.RefinementCtx,
): void {
  const reasons = [...proof.missingProofs, ...proof.blockers];
  if (reasons.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'insufficient decision proof must name at least one missing proof or blocker',
    });
    return;
  }
  if (new Set(reasons).size !== reasons.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'decision proof deficiencies must be unique',
    });
  }
  const expected = [
    ...proof.missingProofs.map((missing) => DECISION_PROOF_WITHDRAWAL_BY_MISSING[missing]),
    ...proof.blockers.map((blocker) => DECISION_PROOF_WITHDRAWAL_BY_BLOCKER[blocker]),
  ];
  if (
    expected.length !== proof.withdrawalConditions.length ||
    expected.some((condition) => !proof.withdrawalConditions.includes(condition))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'decision proof withdrawal conditions must exactly match its deficiencies',
    });
  }
}

export const MeasurementDecisionProofCandidateAssessmentSchema = candidateAssessmentUnion.superRefine(
  (assessment, context) => {
    if (assessment.status !== 'candidate_insufficient') return;
    validateInsufficientDeficiencies(assessment, context);
  },
);

const measurementDecisionProofSchema = measurementDecisionProofUnion.superRefine((proof, context) => {
  if (proof.status !== 'insufficient') return;
  validateInsufficientDeficiencies(proof, context);
});

export type MeasurementDecisionProofCandidate = z.infer<typeof MeasurementDecisionProofCandidateSchema>;
export type MeasurementDecisionProofCandidateAssessment = z.infer<
  typeof MeasurementDecisionProofCandidateAssessmentSchema
>;
export type MeasurementDecisionProof = z.infer<typeof measurementDecisionProofSchema>;
export type MeasurementDecisionProofRecord = z.infer<typeof MeasurementDecisionProofRecordSchema>;
