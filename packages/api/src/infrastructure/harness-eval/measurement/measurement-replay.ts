import { z } from 'zod';

import { type MeasurementBundleResult, MeasurementBundleResultSchema } from './measurement-bundle-schema.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const SameVersionReplayReportSchema = z
  .object({
    kind: z.literal('f267-same-version-replay-report'),
    schemaVersion: z.literal(1),
    reportId: z.string().min(1),
    generatedAt: z.string().datetime(),
    baselineResultId: z.string().min(1),
    replayResultId: z.string().min(1),
    certificateId: z.string().min(1),
    cohort: z
      .object({
        ref: z.string().min(1),
        sha256,
      })
      .strict(),
    decisionProcedureVersionSetHash: sha256,
    outcome: z.enum(['exact_agreement', 'disagreement']),
    differences: z.array(
      z
        .object({
          path: z.enum(['metrics', 'decision', 'actionProposal']),
          baseline: z.unknown(),
          replay: z.unknown(),
        })
        .strict(),
    ),
  })
  .strict();

export type SameVersionReplayReport = z.infer<typeof SameVersionReplayReportSchema>;

export interface SameVersionReplayOptions {
  reportId?: string;
  generatedAt?: string;
}

function stableMetrics(result: MeasurementBundleResult): MeasurementBundleResult['metrics'] {
  return [...result.metrics].sort((left, right) => left.metricId.localeCompare(right.metricId));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildSameVersionReplayReport(
  baselineInput: unknown,
  replayInput: unknown,
  options: SameVersionReplayOptions = {},
): SameVersionReplayReport {
  const baseline = MeasurementBundleResultSchema.parse(baselineInput);
  const replay = MeasurementBundleResultSchema.parse(replayInput);
  if (
    baseline.certificateId !== replay.certificateId ||
    baseline.bundleId !== replay.bundleId ||
    baseline.domainId !== replay.domainId
  ) {
    throw new Error('same-version replay requires identical certificate identity');
  }
  if (baseline.cohort.ref !== replay.cohort.ref || baseline.cohort.sha256 !== replay.cohort.sha256) {
    throw new Error('same-version replay requires an identical frozen cohort ref and hash');
  }
  if (baseline.decisionProcedureVersionSetHash !== replay.decisionProcedureVersionSetHash) {
    throw new Error('same-version replay requires an identical decision procedure version set');
  }

  const comparisons = [
    ['metrics', stableMetrics(baseline), stableMetrics(replay)],
    ['decision', baseline.decision, replay.decision],
    ['actionProposal', baseline.actionProposal, replay.actionProposal],
  ] as const;
  const differences = comparisons
    .filter(([, left, right]) => !sameValue(left, right))
    .map(([path, left, right]) => ({ path, baseline: left, replay: right }));

  return SameVersionReplayReportSchema.parse({
    kind: 'f267-same-version-replay-report',
    schemaVersion: 1,
    reportId: options.reportId ?? `${baseline.resultId}-same-version`,
    generatedAt: options.generatedAt ?? replay.generatedAt,
    baselineResultId: baseline.resultId,
    replayResultId: replay.resultId,
    certificateId: baseline.certificateId,
    cohort: {
      ref: baseline.cohort.ref,
      sha256: baseline.cohort.sha256,
    },
    decisionProcedureVersionSetHash: baseline.decisionProcedureVersionSetHash,
    outcome: differences.length === 0 ? 'exact_agreement' : 'disagreement',
    differences,
  });
}
