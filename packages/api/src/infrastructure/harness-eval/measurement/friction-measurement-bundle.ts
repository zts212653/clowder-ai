import { z } from 'zod';

import { type MeasurementBundleCertificate, type MeasurementBundleResult } from './measurement-bundle-schema.js';
import { parseMeasurementBundleCertificate, validateMeasurementBundleResult } from './measurement-bundle-validation.js';

const FrictionMeasurementSourceSchema = z.object({
  schemaVersion: z.literal(1),
  measurementTarget: z.literal('friction_opportunity_to_action'),
  window: z.object({ sinceMs: z.number().int(), untilMs: z.number().int() }),
  capturedAt: z.string().datetime(),
  cancelJoin: z.object({
    status: z.enum(['complete', 'adapter_gap', 'unexpected_output', 'mismatch', 'no_opportunity', 'unavailable']),
    expectedIds: z.array(z.string()),
    recall: z.number().gte(0).lte(1).nullable(),
  }),
  decision: z.object({
    status: z.enum(['usable', 'insufficient']),
    reasons: z.array(z.string().min(1)),
    withdrawalConditions: z.array(z.string().min(1)),
  }),
});

export interface FrictionMeasurementBundleResultOptions {
  resultId: string;
  certificateRef: string;
  cohortRef: string;
  cohortSha256: string;
  generatedAt: string;
}

function cancelMetric(
  source: z.infer<typeof FrictionMeasurementSourceSchema>,
): MeasurementBundleResult['metrics'][number] {
  const n = source.cancelJoin.expectedIds.length;
  if (n === 0 || source.cancelJoin.recall === null) {
    return {
      metricId: 'cancel_adapter_recall',
      role: 'primary_loss',
      n,
      pointEstimate: null,
      evidenceStatus: 'insufficient',
      uncertainty: {
        kind: 'not_estimable',
        reason: `cancel_join:${source.cancelJoin.status}`,
      },
    };
  }
  return {
    metricId: 'cancel_adapter_recall',
    role: 'primary_loss',
    n,
    pointEstimate: source.cancelJoin.recall,
    evidenceStatus: 'sufficient',
    uncertainty: {
      kind: 'interval',
      method: 'exact_frozen_cohort_reconciliation',
      lower: source.cancelJoin.recall,
      upper: source.cancelJoin.recall,
      confidence: 1,
    },
  };
}

function downstreamMetric(
  source: z.infer<typeof FrictionMeasurementSourceSchema>,
): MeasurementBundleResult['metrics'][number] {
  const available = !source.decision.reasons.includes('downstream_degraded');
  return {
    metricId: 'downstream_available',
    role: 'guardrail',
    n: 1,
    pointEstimate: available ? 1 : 0,
    evidenceStatus: 'sufficient',
    uncertainty: {
      kind: 'power',
      method: 'deterministic_degraded_flag',
      power: 1,
      targetEffect: 'detect any degraded downstream dependency',
    },
  };
}

export function buildFrictionMeasurementBundleResult(
  sourceInput: unknown,
  certificateInput: unknown,
  options: FrictionMeasurementBundleResultOptions,
): MeasurementBundleResult {
  const source = FrictionMeasurementSourceSchema.parse(sourceInput);
  const certificate: MeasurementBundleCertificate = parseMeasurementBundleCertificate(certificateInput);
  if (certificate.domainId !== 'eval:friction' || certificate.measurementTarget.id !== source.measurementTarget) {
    throw new Error('friction measurement source does not match its measurement certificate');
  }

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
      window: {
        startMs: source.window.sinceMs,
        endMs: source.window.untilMs,
      },
    },
    decisionProcedureVersionSetHash: certificate.decisionProcedure.versionSetHash,
    metrics: [cancelMetric(source), downstreamMetric(source)],
    decision: source.decision,
    actionProposal: {
      action: 'keep_observe',
      rationale: 'Evidence remains insufficient; preserve the hard gate and rerun under the withdrawal conditions.',
    },
  };
  return validateMeasurementBundleResult(certificate, result);
}
