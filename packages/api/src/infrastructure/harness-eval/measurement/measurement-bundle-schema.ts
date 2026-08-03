import { z } from 'zod';

import { evalDomainIdSchema } from '../domain/eval-domain-registry.js';

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256');

const decisionMetricBase = {
  id: nonEmpty,
  description: nonEmpty,
  owner: nonEmpty,
  estimator: nonEmpty,
  goodDirection: z.enum(['higher', 'lower']),
};

const contextMetricBase = {
  id: nonEmpty,
  description: nonEmpty,
  owner: nonEmpty,
};

export const MeasurementMetricSchema = z.discriminatedUnion('role', [
  z.object({ ...decisionMetricBase, role: z.literal('primary_loss') }).strict(),
  z.object({ ...decisionMetricBase, role: z.literal('guardrail') }).strict(),
  z.object({ ...contextMetricBase, role: z.literal('context') }).strict(),
  z.object({ ...contextMetricBase, role: z.literal('diagnostic') }).strict(),
]);

export const DecisionProcedureComponentSchema = z
  .object({
    kind: z.enum(['judge', 'rubric', 'classifier', 'prompt', 'model', 'code']),
    name: nonEmpty,
    version: nonEmpty,
    artifactRef: nonEmpty,
    artifactSha256: sha256,
  })
  .strict();

export const InterventionCardSchema = z
  .object({
    observedLoss: nonEmpty,
    competingAttributions: z.array(nonEmpty).min(2),
    keyScientificQuestion: nonEmpty,
    interventionLever: nonEmpty,
    causalRationale: nonEmpty,
    expectedDelta: nonEmpty,
    falsifier: nonEmpty,
    replayCohort: nonEmpty,
    holdout: nonEmpty,
    targetMetricIds: z.array(nonEmpty).min(1),
    guardrailMetricIds: z.array(nonEmpty).min(1),
    reevaluationWindow: nonEmpty,
    costAndRollback: nonEmpty,
  })
  .strict();

export const MeasurementBundleCertificateSchema = z
  .object({
    kind: z.literal('f267-measurement-certificate'),
    schemaVersion: z.literal(1),
    certificateId: nonEmpty,
    bundleId: nonEmpty,
    domainId: evalDomainIdSchema,
    status: z.literal('issued'),
    measurementTarget: z
      .object({
        id: nonEmpty,
        estimand: nonEmpty,
        utilityClaim: nonEmpty,
        unitOfAnalysis: nonEmpty,
      })
      .strict(),
    decision: z
      .object({
        consumerFeatureId: z.string().regex(/^F\d{3}$/),
        consumerOwnerCatId: nonEmpty,
        allowedActions: z.array(z.enum(['keep_observe', 'fix', 'build', 'delete_sunset'])).min(1),
        primaryQuestion: nonEmpty,
      })
      .strict(),
    targetPopulation: z
      .object({
        description: nonEmpty,
        inclusion: z.array(nonEmpty).min(1),
        exclusion: z.array(nonEmpty),
      })
      .strict(),
    window: z
      .object({
        boundary: z.literal('half_open'),
        selection: nonEmpty,
        maxDurationHours: z.number().positive(),
      })
      .strict(),
    metrics: z.array(MeasurementMetricSchema).min(1),
    errorCosts: z
      .object({
        falsePositive: nonEmpty,
        falseNegative: nonEmpty,
      })
      .strict(),
    validityBounds: z.array(nonEmpty).min(1),
    sampleContract: z
      .object({
        unit: nonEmpty,
        inclusion: nonEmpty,
        exclusion: nonEmpty,
        missingness: nonEmpty,
      })
      .strict(),
    uncertainty: z
      .object({
        method: nonEmpty,
        requiredEvidence: z
          .object({
            n: z.literal(true),
            pointEstimate: z.literal(true),
            intervalOrPower: z.literal(true),
          })
          .strict(),
        insufficientWhen: z.array(nonEmpty).min(1),
      })
      .strict(),
    calibrationPlan: z
      .object({
        reference: nonEmpty,
        cadence: nonEmpty,
        failureThreshold: nonEmpty,
        action: nonEmpty,
      })
      .strict(),
    withdrawalConditions: z.array(nonEmpty).min(1),
    interventionPolicy: z
      .object({
        requiredFor: z.array(z.enum(['fix', 'build', 'delete_sunset'])).length(3),
      })
      .strict(),
    decisionProcedure: z
      .object({
        artifactRevision: z.string().regex(/^[a-f0-9]{40}$/, 'must be a full Git revision'),
        components: z.array(DecisionProcedureComponentSchema).min(1),
        versionSetHash: sha256,
      })
      .strict(),
    repeatabilityContract: z
      .object({
        stage: z.enum(['acceptance', 'decision']),
        frozenCohortContract: nonEmpty,
        minimumRuns: z.number().int().min(2),
        allowedVariation: nonEmpty,
        tolerance: nonEmpty,
      })
      .strict(),
    provenance: z
      .object({
        featureId: z.literal('F267'),
        sourceRevision: z.string().regex(/^[a-f0-9]{40}$/, 'must be a full Git revision'),
        generatedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

const IntervalEvidenceSchema = z
  .object({
    kind: z.literal('interval'),
    method: nonEmpty,
    lower: z.number(),
    upper: z.number(),
    confidence: z.number().gt(0).lte(1),
  })
  .strict();

const PowerEvidenceSchema = z
  .object({
    kind: z.literal('power'),
    method: nonEmpty,
    power: z.number().gte(0).lte(1),
    targetEffect: nonEmpty,
  })
  .strict();

const NotEstimableEvidenceSchema = z
  .object({
    kind: z.literal('not_estimable'),
    reason: nonEmpty,
  })
  .strict();

export const MeasurementResultMetricSchema = z
  .object({
    metricId: nonEmpty,
    role: z.enum(['primary_loss', 'guardrail']),
    n: z.number().int().nonnegative(),
    pointEstimate: z.number().nullable(),
    evidenceStatus: z.enum(['sufficient', 'insufficient']),
    uncertainty: z.discriminatedUnion('kind', [
      IntervalEvidenceSchema,
      PowerEvidenceSchema,
      NotEstimableEvidenceSchema,
    ]),
  })
  .strict();

const UsableDecisionSchema = z
  .object({
    status: z.literal('usable'),
    reasons: z.array(nonEmpty).max(0),
    withdrawalConditions: z.array(nonEmpty).max(0),
  })
  .strict();

const InsufficientDecisionSchema = z
  .object({
    status: z.literal('insufficient'),
    reasons: z.array(nonEmpty).min(1),
    withdrawalConditions: z.array(nonEmpty).min(1),
  })
  .strict();

export const MeasurementBundleResultSchema = z
  .object({
    kind: z.literal('f267-measurement-bundle-result'),
    schemaVersion: z.literal(1),
    resultId: nonEmpty,
    certificateId: nonEmpty,
    certificateRef: nonEmpty,
    bundleId: nonEmpty,
    domainId: evalDomainIdSchema,
    generatedAt: z.string().datetime(),
    cohort: z
      .object({
        ref: nonEmpty,
        sha256,
        window: z
          .object({
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    decisionProcedureVersionSetHash: sha256,
    metrics: z.array(MeasurementResultMetricSchema).min(1),
    decision: z.discriminatedUnion('status', [UsableDecisionSchema, InsufficientDecisionSchema]),
    actionProposal: z
      .object({
        action: z.enum(['keep_observe', 'fix', 'build', 'delete_sunset']),
        rationale: nonEmpty,
        interventionCard: InterventionCardSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type DecisionProcedureComponent = z.infer<typeof DecisionProcedureComponentSchema>;
export type InterventionCard = z.infer<typeof InterventionCardSchema>;
export type MeasurementBundleCertificate = z.infer<typeof MeasurementBundleCertificateSchema>;
export type MeasurementBundleResult = z.infer<typeof MeasurementBundleResultSchema>;
export type MeasurementMetric = z.infer<typeof MeasurementMetricSchema>;
