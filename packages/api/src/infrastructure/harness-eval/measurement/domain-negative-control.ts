import { z } from 'zod';

import { evalDomainIdSchema } from '../domain/eval-domain-registry.js';
import { type MeasurementBundleResult } from './measurement-bundle-schema.js';
import { parseMeasurementBundleCertificate, validateMeasurementBundleResult } from './measurement-bundle-validation.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const jsonPointer = z.string().regex(/^\/(?:[^~/]|~[01])*(?:\/(?:[^~/]|~[01])*)*$/);
const safeRef = z
  .string()
  .min(1)
  .refine((ref) => !ref.startsWith('/') && !ref.includes('..') && !ref.includes('\\'));
const observedValue = z.union([z.number().finite(), z.string(), z.boolean(), z.null()]);

const NumericWindowSourceSchema = z
  .object({
    kind: z.literal('numeric_json_pointer'),
    startMsPointer: jsonPointer,
    endMsPointer: jsonPointer,
  })
  .strict();

const GeneratedDurationWindowSourceSchema = z
  .object({
    kind: z.literal('generated_at_duration_hours_json_pointer'),
    generatedAtPointer: jsonPointer,
    durationHoursPointer: jsonPointer,
  })
  .strict();

const ObservationValueSchema = z
  .object({
    metricId: z.string().min(1),
    jsonPointer,
    value: observedValue,
  })
  .strict();

const BlockingObservationSchema = z
  .object({
    metricId: z.string().min(1),
    operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
    threshold: observedValue,
    reason: z.string().min(1),
    withdrawalCondition: z.string().min(1),
  })
  .strict();

const SupportingArtifactSchema = z
  .object({
    ref: safeRef,
    sha256,
    requiredLiterals: z.array(z.string().min(1)).min(1),
  })
  .strict();

const DomainNegativeControlCaseSchema = z
  .object({
    caseId: z.string().min(1),
    role: z.enum(['reference_window', 'negative_control']),
    snapshotRef: safeRef,
    snapshotSha256: sha256,
    verdictRef: safeRef,
    verdictSha256: sha256,
    supportingArtifacts: z.array(SupportingArtifactSchema),
    window: z
      .object({
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
        source: z.discriminatedUnion('kind', [NumericWindowSourceSchema, GeneratedDurationWindowSourceSchema]),
      })
      .strict(),
    observation: z
      .object({
        verdict: z.enum(['keep_observe', 'fix', 'build', 'delete_sunset']),
        values: z.array(ObservationValueSchema).min(1),
      })
      .strict(),
    blockingObservations: z.array(BlockingObservationSchema),
  })
  .strict();

export const DomainNegativeControlCohortSchema = z
  .object({
    kind: z.literal('f267-domain-negative-control-cohort'),
    schemaVersion: z.literal(1),
    cohortId: z.string().min(1),
    domainId: evalDomainIdSchema,
    measurementTargetId: z.string().min(1),
    cases: z.array(DomainNegativeControlCaseSchema).min(2),
  })
  .strict();

export type DomainNegativeControlCohort = z.infer<typeof DomainNegativeControlCohortSchema>;
export type DomainNegativeControlCase = DomainNegativeControlCohort['cases'][number];

export interface DomainNegativeControlResultOptions {
  resultId: string;
  certificateRef: string;
  cohortRef: string;
  cohortSha256: string;
  generatedAt: string;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function assertCaseContract(item: DomainNegativeControlCase): void {
  if (item.window.startMs >= item.window.endMs) {
    throw new Error(`domain negative-control window is empty for ${item.caseId}`);
  }
  assertUnique(
    item.observation.values.map((value) => value.metricId),
    `domain negative-control observation metric ids for ${item.caseId}`,
  );
  assertUnique(
    item.supportingArtifacts.map((artifact) => artifact.ref),
    `domain negative-control supporting artifact refs for ${item.caseId}`,
  );
  const observedIds = new Set(item.observation.values.map((value) => value.metricId));
  for (const blocker of item.blockingObservations) {
    if (!observedIds.has(blocker.metricId)) {
      throw new Error(`blocking observation ${blocker.metricId} is not present for ${item.caseId}`);
    }
  }
  if (item.role === 'reference_window' && item.blockingObservations.length > 0) {
    throw new Error(`reference window cannot declare blocking observations: ${item.caseId}`);
  }
  if (item.role === 'negative_control' && item.blockingObservations.length === 0) {
    throw new Error(`negative control requires a blocking observation: ${item.caseId}`);
  }
}

export function parseDomainNegativeControlCohort(input: unknown): DomainNegativeControlCohort {
  const cohort = DomainNegativeControlCohortSchema.parse(input);
  const reference = cohort.cases.filter((item) => item.role === 'reference_window');
  const negative = cohort.cases.filter((item) => item.role === 'negative_control');
  if (reference.length === 0 || negative.length === 0) {
    throw new Error('domain negative control requires at least one reference window and one negative control');
  }
  assertUnique(
    cohort.cases.map((item) => item.caseId),
    'domain negative-control case ids',
  );
  assertUnique(
    cohort.cases.map((item) => item.snapshotRef),
    'domain negative-control snapshot refs',
  );
  assertUnique(
    cohort.cases.map((item) => item.verdictRef),
    'domain negative-control verdict refs',
  );
  cohort.cases.forEach(assertCaseContract);
  return cohort;
}

function conditionMatches(actual: string | number | boolean | null, operator: string, threshold: unknown): boolean {
  if (operator === 'eq') return actual === threshold;
  if (operator === 'ne') return actual !== threshold;
  if (typeof actual !== 'number' || typeof threshold !== 'number') {
    throw new Error(`operator ${operator} requires numeric observation and threshold`);
  }
  if (operator === 'lt') return actual < threshold;
  if (operator === 'lte') return actual <= threshold;
  if (operator === 'gt') return actual > threshold;
  if (operator === 'gte') return actual >= threshold;
  throw new Error(`unsupported blocking observation operator: ${operator}`);
}

function exactMetric(
  metricId: string,
  role: 'primary_loss' | 'guardrail',
  n: number,
  pointEstimate: number,
): MeasurementBundleResult['metrics'][number] {
  return {
    metricId,
    role,
    n,
    pointEstimate,
    evidenceStatus: 'sufficient',
    uncertainty: {
      kind: 'interval',
      method: 'exact_frozen_source_reconstruction',
      lower: pointEstimate,
      upper: pointEstimate,
      confidence: 1,
    },
  };
}

export function buildDomainNegativeControlResult(
  cohortInput: unknown,
  certificateInput: unknown,
  options: DomainNegativeControlResultOptions,
): MeasurementBundleResult {
  const cohort = parseDomainNegativeControlCohort(cohortInput);
  const certificate = parseMeasurementBundleCertificate(certificateInput);
  if (certificate.domainId !== cohort.domainId || certificate.measurementTarget.id !== cohort.measurementTargetId) {
    throw new Error('domain negative-control cohort does not match its measurement certificate');
  }

  const negativeCases = cohort.cases.filter((item) => item.role === 'negative_control');
  const reasons: string[] = [];
  const withdrawalConditions: string[] = [];
  for (const item of negativeCases) {
    const values = new Map(item.observation.values.map((value) => [value.metricId, value.value]));
    const matches = item.blockingObservations.filter((blocker) =>
      conditionMatches(values.get(blocker.metricId) ?? null, blocker.operator, blocker.threshold),
    );
    if (matches.length === 0) {
      throw new Error(`negative-control blocking observation does not reproduce for ${item.caseId}`);
    }
    reasons.push(...matches.map((blocker) => blocker.reason));
    withdrawalConditions.push(...matches.map((blocker) => blocker.withdrawalCondition));
  }

  const startMs = Math.min(...cohort.cases.map((item) => item.window.startMs));
  const endMs = Math.max(...cohort.cases.map((item) => item.window.endMs));
  const uniqueReasons = [...new Set(reasons)].sort();
  const uniqueWithdrawals = [...new Set(withdrawalConditions)].sort();
  const result: MeasurementBundleResult = {
    kind: 'f267-measurement-bundle-result',
    schemaVersion: 1,
    resultId: options.resultId,
    certificateId: certificate.certificateId,
    certificateRef: options.certificateRef,
    bundleId: certificate.bundleId,
    domainId: certificate.domainId,
    generatedAt: options.generatedAt,
    cohort: {
      ref: options.cohortRef,
      sha256: options.cohortSha256,
      window: { startMs, endMs },
    },
    decisionProcedureVersionSetHash: certificate.decisionProcedure.versionSetHash,
    metrics: [
      exactMetric('negative_control_gap_rate', 'primary_loss', negativeCases.length, 1),
      exactMetric('cohort_case_coverage', 'guardrail', cohort.cases.length, 1),
    ],
    decision: {
      status: 'insufficient',
      reasons: uniqueReasons,
      withdrawalConditions: uniqueWithdrawals,
    },
    actionProposal: {
      action: 'keep_observe',
      rationale:
        'The pinned negative control reproduces a validity-blocking observation; refuse fix/build/delete_sunset until its withdrawal condition is satisfied by a new versioned cohort.',
    },
  };
  return validateMeasurementBundleResult(certificate, result);
}
