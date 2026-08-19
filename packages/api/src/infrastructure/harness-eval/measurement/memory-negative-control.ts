import { z } from 'zod';

import { type MeasurementBundleCertificate, type MeasurementBundleResult } from './measurement-bundle-schema.js';
import { parseMeasurementBundleCertificate, validateMeasurementBundleResult } from './measurement-bundle-validation.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const safeRef = z
  .string()
  .min(1)
  .refine((ref) => !ref.startsWith('/') && !ref.includes('..') && !ref.includes('\\'));

const WindowSchema = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  })
  .strict();

const SourceFieldsSchema = z.object({
  caseId: z.string().min(1),
  snapshotRef: safeRef,
  snapshotSha256: sha256,
  verdictRef: safeRef,
  verdictSha256: sha256,
  window: WindowSchema,
});

const GreenWindowSchema = SourceFieldsSchema.extend({
  role: z.literal('green_window'),
  observation: z
    .object({
      verdict: z.literal('keep_observe'),
      totalSearches: z.number().int().positive(),
      observedSearches: z.number().int().positive(),
    })
    .strict(),
}).strict();

const ProductionIncidentSchema = SourceFieldsSchema.extend({
  role: z.literal('production_incident'),
  observation: z
    .object({
      verdict: z.enum(['fix', 'build', 'delete_sunset']),
      totalSearches: z.number().int().nonnegative(),
      observedSearches: z.number().int().nonnegative(),
    })
    .strict(),
  incidentTruth: z
    .object({
      officialObservedSearches: z.literal(0),
      underlyingSearchLogRows: z.number().int().positive(),
      directObservedSearches: z.number().int().positive(),
    })
    .strict(),
}).strict();

export const MemoryNegativeControlCohortSchema = z
  .object({
    kind: z.literal('f267-memory-negative-control-cohort'),
    schemaVersion: z.literal(1),
    cohortId: z.string().min(1),
    domainId: z.literal('eval:memory'),
    cases: z.array(z.discriminatedUnion('role', [GreenWindowSchema, ProductionIncidentSchema])).min(1),
  })
  .strict();

export type MemoryNegativeControlCohort = z.infer<typeof MemoryNegativeControlCohortSchema>;

export interface MemoryNegativeControlResultOptions {
  resultId: string;
  certificateRef: string;
  cohortRef: string;
  cohortSha256: string;
  generatedAt: string;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

export function parseMemoryNegativeControlCohort(input: unknown): MemoryNegativeControlCohort {
  const cohort = MemoryNegativeControlCohortSchema.parse(input);
  const green = cohort.cases.filter((item): item is z.infer<typeof GreenWindowSchema> => item.role === 'green_window');
  const incidents = cohort.cases.filter(
    (item): item is z.infer<typeof ProductionIncidentSchema> => item.role === 'production_incident',
  );
  if (green.length !== 3 || incidents.length !== 1) {
    throw new Error('memory negative control requires exactly three green windows and one production incident');
  }
  if (
    cohort.cases.slice(0, 3).some((item) => item.role !== 'green_window') ||
    cohort.cases[3]?.role !== 'production_incident'
  ) {
    throw new Error('memory negative control cases must order three green windows before the production incident');
  }
  assertUnique(
    cohort.cases.map((item) => item.caseId),
    'memory negative-control case ids',
  );
  for (const item of cohort.cases) {
    if (item.window.startMs >= item.window.endMs)
      throw new Error(`negative-control window is empty for ${item.caseId}`);
  }
  for (let index = 1; index < green.length; index += 1) {
    const previous = green[index - 1];
    const current = green[index];
    if (!previous || !current || current.window.startMs <= previous.window.startMs) {
      throw new Error('green negative-control windows must be in chronological order');
    }
    if (current.window.startMs > previous.window.endMs) {
      throw new Error('green negative-control windows must form a continuous overlapping sequence');
    }
  }
  const latestGreen = green.at(-1);
  const incident = incidents[0];
  if (
    !latestGreen ||
    !incident ||
    incident.window.startMs < latestGreen.window.startMs ||
    incident.window.endMs <= latestGreen.window.endMs
  ) {
    throw new Error('production incident must extend the frozen green-window sequence');
  }
  return cohort;
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
      method: 'exact_frozen_case_reconciliation',
      lower: pointEstimate,
      upper: pointEstimate,
      confidence: 1,
    },
  };
}

export function buildMemoryNegativeControlResult(
  cohortInput: unknown,
  certificateInput: unknown,
  options: MemoryNegativeControlResultOptions,
): MeasurementBundleResult {
  const cohort = parseMemoryNegativeControlCohort(cohortInput);
  const certificate: MeasurementBundleCertificate = parseMeasurementBundleCertificate(certificateInput);
  if (
    certificate.domainId !== 'eval:memory' ||
    certificate.measurementTarget.id !== 'memory_search_quality_negative_control_validity'
  ) {
    throw new Error('memory negative-control cohort does not match its measurement certificate');
  }

  const green = cohort.cases.filter((item): item is z.infer<typeof GreenWindowSchema> => item.role === 'green_window');
  const incident = cohort.cases.find(
    (item): item is z.infer<typeof ProductionIncidentSchema> => item.role === 'production_incident',
  );
  if (!incident) throw new Error('memory negative-control incident is missing');
  const coveredGreen = green.filter(
    (item) => item.observation.totalSearches >= 200 && item.observation.observedSearches >= 200,
  ).length;
  const incidentDetected = 1;
  const incidentConsistent =
    incident.observation.observedSearches === incident.incidentTruth.officialObservedSearches ? 1 : 0;
  const isUsable = coveredGreen === green.length && incidentDetected === 1 && incidentConsistent === 1;
  const startMs = Math.min(...cohort.cases.map((item) => item.window.startMs));
  const endMs = Math.max(...cohort.cases.map((item) => item.window.endMs));

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
      exactMetric('green_window_coverage', 'primary_loss', green.length, coveredGreen / green.length),
      exactMetric('incident_detection_rate', 'guardrail', 1, incidentDetected),
      exactMetric('incident_evidence_consistency', 'guardrail', 1, incidentConsistent),
    ],
    decision: isUsable
      ? { status: 'usable', reasons: [], withdrawalConditions: [] }
      : {
          status: 'insufficient',
          reasons: ['incident_truth_and_checked_snapshot_do_not_reproduce_the_same_observation'],
          withdrawalConditions: [
            'commit the direct incident observation or regenerate a snapshot that reproduces the pinned official output',
          ],
        },
    actionProposal: {
      action: 'keep_observe',
      rationale: isUsable
        ? 'The frozen negative-control contrast is reproducible; keep observing until a separate action result is issued.'
        : 'Evidence lineage is inconsistent; refuse fix/build/sunset and keep observing until the source bundle is repaired.',
    },
  };
  return validateMeasurementBundleResult(certificate, result);
}
