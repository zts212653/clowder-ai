import { z } from 'zod';

export const ADAPTIVE_SOP_PLAN_SCHEMA_VERSION = 'adaptive-sop-plan.v1' as const;
export const SOP_ADMISSION_DECISION_SCHEMA_VERSION = 'sop-admission-decision.v1' as const;
export const SOP_TRIAL_EPISODE_SCHEMA_VERSION = 'sop-trial-episode.v1' as const;

const NonEmptyStringSchema = z.string().trim().min(1);
const Sha1Schema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const IsoTimestampSchema = z.string().datetime({ offset: true });

export const AdaptiveSopModelSchema = z
  .object({
    provider: NonEmptyStringSchema,
    modelId: NonEmptyStringSchema,
    harnessVersion: NonEmptyStringSchema,
  })
  .strict();

export const AdaptiveSopRepositoryFactsSchema = z
  .object({
    worktreeRoot: NonEmptyStringSchema.optional(),
    branch: NonEmptyStringSchema.optional(),
    baseSha: Sha1Schema.optional(),
    changedFiles: z.array(NonEmptyStringSchema).optional(),
    diffFingerprint: Sha256Schema.optional(),
  })
  .strict();

export const AdaptiveSopRiskSchema = z
  .object({
    claim: NonEmptyStringSchema,
    evidence: z.array(NonEmptyStringSchema),
    uncertainty: z.array(NonEmptyStringSchema),
  })
  .strict();

export const AdaptiveSopDecisionSchema = z
  .object({
    stepId: NonEmptyStringSchema,
    action: z.enum(['include', 'omit', 'replace']),
    reason: NonEmptyStringSchema,
    residualRisk: NonEmptyStringSchema,
    replacementEvidence: z.array(NonEmptyStringSchema).optional(),
  })
  .strict();

export const AdaptiveSopPlanSchema = z
  .object({
    schemaVersion: z.literal(ADAPTIVE_SOP_PLAN_SCHEMA_VERSION),
    episodeId: NonEmptyStringSchema,
    model: AdaptiveSopModelSchema,
    taskUnderstanding: NonEmptyStringSchema,
    desiredOutcome: z.array(NonEmptyStringSchema).min(1),
    repositoryFacts: AdaptiveSopRepositoryFactsSchema,
    risks: z.array(AdaptiveSopRiskSchema).min(1),
    decisions: z.array(AdaptiveSopDecisionSchema).min(1),
    executionOrder: z.array(NonEmptyStringSchema).min(1),
    outcomeChecks: z.array(NonEmptyStringSchema).min(1),
    replanTriggers: z.array(NonEmptyStringSchema).min(1),
    rollbackPlan: NonEmptyStringSchema,
  })
  .strict();

const AdmittedDecisionSchema = z
  .object({
    schemaVersion: z.literal(SOP_ADMISSION_DECISION_SCHEMA_VERSION),
    status: z.literal('admitted'),
    episodeId: NonEmptyStringSchema,
    envelopeFingerprint: Sha256Schema,
  })
  .strict();

const ReviseDecisionSchema = z
  .object({
    schemaVersion: z.literal(SOP_ADMISSION_DECISION_SCHEMA_VERSION),
    status: z.literal('revise'),
    violations: z.array(NonEmptyStringSchema).min(1),
    requiredFacts: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();

const BlockedDecisionSchema = z
  .object({
    schemaVersion: z.literal(SOP_ADMISSION_DECISION_SCHEMA_VERSION),
    status: z.literal('blocked'),
    invariant: NonEmptyStringSchema,
    fallback: z.enum(['full_sop', 'operator']),
  })
  .strict();

export const SopAdmissionDecisionSchema = z.discriminatedUnion('status', [
  AdmittedDecisionSchema,
  ReviseDecisionSchema,
  BlockedDecisionSchema,
]);

export const SopActualStepSchema = z
  .object({
    stage: NonEmptyStringSchema.optional(),
    commandOrTool: NonEmptyStringSchema,
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
    exitCode: z.number().int().optional(),
    evidenceRef: NonEmptyStringSchema.optional(),
  })
  .strict();

export const SopTrialOutcomeSchema = z
  .object({
    requestedOutcomeMet: z.union([z.boolean(), z.literal('unknown')]),
    testsPassed: z.union([z.boolean(), z.enum(['not_applicable', 'unknown'])]),
    reviewFindingCounts: z
      .object({
        p1: NonNegativeIntegerSchema,
        p2: NonNegativeIntegerSchema,
        p3: NonNegativeIntegerSchema,
      })
      .strict(),
    operatorCorrection: z.boolean(),
    rollback: z.boolean(),
    escapedRegression: z.union([z.boolean(), z.literal('unknown')]),
  })
  .strict();

const MeasuredCostSchema = z.union([NonNegativeIntegerSchema, z.literal('missing')]);

export const SopTrialCostSchema = z
  .object({
    invocations: MeasuredCostSchema,
    toolCalls: MeasuredCostSchema,
    inputTokens: MeasuredCostSchema,
    outputTokens: MeasuredCostSchema,
    wallTimeMs: MeasuredCostSchema,
    gateDurationMs: MeasuredCostSchema,
  })
  .strict();

export const SopTrialEpisodeSchema = z
  .object({
    schemaVersion: z.literal(SOP_TRIAL_EPISODE_SCHEMA_VERSION),
    plan: AdaptiveSopPlanSchema,
    admission: SopAdmissionDecisionSchema,
    actualSteps: z.array(SopActualStepSchema),
    outcome: SopTrialOutcomeSchema,
    cost: SopTrialCostSchema,
    telemetryComplete: z.boolean(),
    missingFields: z.array(NonEmptyStringSchema),
  })
  .strict();

export type AdaptiveSopModel = z.infer<typeof AdaptiveSopModelSchema>;
export type AdaptiveSopRepositoryFacts = z.infer<typeof AdaptiveSopRepositoryFactsSchema>;
export type AdaptiveSopRisk = z.infer<typeof AdaptiveSopRiskSchema>;
export type AdaptiveSopDecision = z.infer<typeof AdaptiveSopDecisionSchema>;
export type AdaptiveSopPlan = z.infer<typeof AdaptiveSopPlanSchema>;
export type SopAdmissionDecision = z.infer<typeof SopAdmissionDecisionSchema>;
export type SopActualStep = z.infer<typeof SopActualStepSchema>;
export type SopTrialOutcome = z.infer<typeof SopTrialOutcomeSchema>;
export type SopTrialCost = z.infer<typeof SopTrialCostSchema>;
export type SopTrialEpisode = z.infer<typeof SopTrialEpisodeSchema>;
