import { z } from 'zod';

export const MICRODUCK_CONTROL_SUBJECT_ORDER = [
  'baseline',
  'control',
  'action-scale-090',
  'action-scale-105',
  'action-scale-110',
] as const;

export const MICRODUCK_CONTROL_CANDIDATE_ORDER = ['action-scale-090', 'action-scale-105', 'action-scale-110'] as const;
export type MicroduckControlCandidateId = (typeof MICRODUCK_CONTROL_CANDIDATE_ORDER)[number];

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const policyRefSchema = z.string().regex(/^hf-space:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[a-f0-9]{40}#\S+\.onnx$/u);
const controlConfigRefSchema = z.string().regex(/^control-config:sha256:[a-f0-9]{64}$/u);
const controlPackageRefSchema = z.string().regex(/^control-package:sha256:[a-f0-9]{64}$/u);
const runnerRefSchema = z.string().regex(/^runner:sha256:[a-f0-9]{64}$/u);
const evaluationEnvRefSchema = z.string().regex(/^evaluation-env:sha256:[a-f0-9]{64}$/u);
const seedSetRefSchema = z.string().regex(/^seed-set:sha256:[a-f0-9]{64}$/u);
const captureRefSchema = z.string().regex(/^capture:sha256:[a-f0-9]{64}$/u);
const immutableEvidenceRefSchema = z.string().regex(/^[a-z][a-z0-9-]*:sha256:[a-f0-9]{64}$/u);

export const microduckControlComparisonContractSchema = z
  .object({
    allCandidatesRunHoldout: z.literal(true),
    candidateSelectionSource: z.literal('public_only'),
    guardrailMetric: z
      .object({
        direction: z.literal('higher_is_better'),
        key: z.literal('survivalRate'),
        nonInferiorityMargin: z.literal(0),
        rule: z.literal('candidate_control_delta_gte_negative_non_inferiority_margin'),
      })
      .strict(),
    holdoutRole: z.literal('confirm_or_reject_preselected_candidate'),
    matchedControlSubjectId: z.literal('control'),
    minSeedCount: z.literal(8),
    otherwise: z.literal('no_measured_improvement'),
    primaryMetric: z
      .object({
        direction: z.literal('higher_is_better'),
        key: z.literal('meanForwardDistanceM'),
        rule: z.literal('candidate_control_delta_gt_k_times_combined_standard_error'),
      })
      .strict(),
    reportingMetric: z
      .object({ direction: z.literal('lower_is_better'), key: z.literal('meanAbsVelocityErrorMps') })
      .strict(),
    requiredMetricKeys: z.tuple([
      z.literal('meanAbsVelocityErrorMps'),
      z.literal('meanForwardDistanceM'),
      z.literal('survivalRate'),
    ]),
    selectionRule: z.literal('eligible_candidate_with_largest_primary_delta_then_subject_order'),
    standardErrorEstimator: z.literal('sample_standard_deviation_divided_by_sqrt_n'),
    standardErrorMultiplier: z.literal(2),
  })
  .strict();

export const microduckControlSubjectSchema = z
  .object({
    actionScale: z.number(),
    artifactRef: controlPackageRefSchema,
    artifactVersion: sha256Schema,
    configPath: z.string().min(1),
    configRef: controlConfigRefSchema,
    configSha256: sha256Schema,
    evaluationEnvRef: evaluationEnvRefSchema,
    id: z.enum(MICRODUCK_CONTROL_SUBJECT_ORDER),
    policyRef: policyRefSchema,
    policySha256: sha256Schema,
    role: z.enum(['deployed_reference', 'matched_control', 'candidate']),
    runnerRef: runnerRefSchema,
  })
  .strict();

export const microduckControlExperimentSchema = z
  .object({
    comparisonContract: microduckControlComparisonContractSchema,
    evaluationEnvPath: z.literal('control-configs/evaluation-environment-v1.json'),
    evaluationEnvRef: evaluationEnvRefSchema,
    evaluationEnvSha256: sha256Schema,
    experimentId: z.literal('f311-microduck-fixed-model-action-scale-v1'),
    interventionKind: z.literal('control_config'),
    outcomesObservedBeforePreregistration: z.literal(false),
    policyRef: policyRefSchema,
    policySha256: sha256Schema,
    preregisteredAt: z.string().datetime({ offset: true }),
    publicSeedSet: z
      .object({
        count: z.literal(8),
        path: z.literal('control-configs/public-seeds-v1.json'),
        ref: seedSetRefSchema,
        sha256: sha256Schema,
      })
      .strict(),
    runnerPath: z.literal('bin/microduck_control_runner.py'),
    runnerRef: runnerRefSchema,
    runnerSha256: sha256Schema,
    schemaVersion: z.literal(1),
    status: z.literal('preregistered'),
    subjectOrder: z.tuple([
      z.literal('baseline'),
      z.literal('control'),
      z.literal('action-scale-090'),
      z.literal('action-scale-105'),
      z.literal('action-scale-110'),
    ]),
    subjects: z.array(microduckControlSubjectSchema).length(5),
  })
  .strict();

const metricSchema = z.object({ estimate: z.number(), standardError: z.number().nonnegative() }).strict();
const metricsSchema = z
  .object({
    meanAbsVelocityErrorMps: metricSchema,
    meanForwardDistanceM: metricSchema,
    survivalRate: metricSchema,
  })
  .strict();
const refusalSchema = z
  .object({
    code: z.string().min(1),
    detailHash: sha256Schema.nullable(),
    evidenceRef: immutableEvidenceRefSchema.nullable(),
  })
  .strict();
const evaluationSchema = z
  .object({
    captureRef: captureRefSchema.nullable(),
    metrics: metricsSchema.nullable(),
    refusal: refusalSchema.nullable(),
    sampleCount: z.number().int().min(8).nullable(),
    split: z.enum(['public', 'holdout']),
    status: z.enum(['passed', 'failed', 'refused', 'missing']),
  })
  .strict();
const receiptSubjectSchema = z
  .object({
    artifactRef: controlPackageRefSchema,
    artifactVersion: sha256Schema,
    configRef: controlConfigRefSchema,
    configSha256: sha256Schema,
    evaluationEnvRef: evaluationEnvRefSchema,
    evaluations: z.array(evaluationSchema).length(2),
    id: z.enum(MICRODUCK_CONTROL_SUBJECT_ORDER),
    interventionKind: z.literal('control_config'),
    policyRef: policyRefSchema,
    policySha256: sha256Schema,
    role: z.enum(['deployed_reference', 'matched_control', 'candidate']),
    runnerRef: runnerRefSchema,
  })
  .strict();
const publicDecisionCandidateSchema = z
  .object({
    eligible: z.boolean(),
    guardrailDelta: z.number(),
    guardrailMinimumDelta: z.literal(0),
    guardrailPass: z.boolean(),
    primaryDelta: z.number(),
    primarySignal: z.boolean(),
    primaryThreshold: z.number().nonnegative(),
    subjectId: z.enum(MICRODUCK_CONTROL_CANDIDATE_ORDER),
  })
  .strict();

export const microduckControlEvaluationReceiptSchema = z
  .object({
    comparisonContract: microduckControlComparisonContractSchema,
    completeness: z.enum(['public_complete', 'full_complete']),
    evaluationEnvRef: evaluationEnvRefSchema,
    evaluatorRevision: revisionSchema,
    experimentRef: z.string().regex(/^control-experiment:sha256:[a-f0-9]{64}$/u),
    holdoutProof: z
      .object({
        optimizerExposed: z.boolean(),
        optimizerExposureProofRef: z.string().regex(/^exposure-proof:sha256:[a-f0-9]{64}$/u),
        sealedProofRef: z.string().regex(/^evaluation-proof:sha256:[a-f0-9]{64}$/u),
      })
      .strict()
      .nullable(),
    interventionKind: z.literal('control_config'),
    kind: z.literal('microduck_control_evaluation'),
    publicDecision: z
      .object({
        candidates: z.array(publicDecisionCandidateSchema).length(3),
        outcome: z.enum(['candidate_preselected_for_holdout', 'no_measured_improvement']),
        rule: z.literal('eligible_candidate_with_largest_primary_delta_then_subject_order'),
        selectedSubjectId: z.enum(MICRODUCK_CONTROL_CANDIDATE_ORDER).nullable(),
      })
      .strict()
      .nullable(),
    receiptSha256: sha256Schema,
    runnerRef: runnerRefSchema,
    schemaVersion: z.literal(1),
    seedSets: z
      .object({
        holdout: z.object({ ref: seedSetRefSchema, sha256: sha256Schema }).strict().nullable(),
        public: z.object({ ref: seedSetRefSchema, sha256: sha256Schema }).strict(),
      })
      .strict(),
    subjects: z.array(receiptSubjectSchema).length(5),
  })
  .strict();

export type MicroduckControlExperiment = z.infer<typeof microduckControlExperimentSchema>;
export type MicroduckControlEvaluationReceipt = z.infer<typeof microduckControlEvaluationReceiptSchema>;
export type MicroduckControlEvaluation = z.infer<typeof evaluationSchema>;
export type MicroduckControlMetrics = z.infer<typeof metricsSchema>;
