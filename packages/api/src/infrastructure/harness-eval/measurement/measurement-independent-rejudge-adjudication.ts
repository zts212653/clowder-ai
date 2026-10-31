import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { parse } from 'yaml';
import { z } from 'zod';

import type { CheckedArtifact, IndependentRejudge } from './measurement-independent-rejudge-judgment.js';
import { validateIndependentRejudge } from './measurement-independent-rejudge-judgment.js';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const DecisionSchema = z.enum(['usable', 'insufficient']);
const AdjudicationReasonCodeSchema = z.enum([
  'baseline_decision_mismatch',
  'baseline_action_mismatch',
  'independent_evidence_preferred',
]);

const AdjudicationSchema = z
  .object({
    finalDecision: DecisionSchema,
    finalAction: z.literal('keep_observe'),
    reasonCodes: z.array(AdjudicationReasonCodeSchema).min(1),
  })
  .strict();

const ReportItemSchema = z
  .object({
    itemId: z.string().regex(/^item-\d{3}$/),
    baseline: z
      .object({
        decision: DecisionSchema,
        action: z.string().min(1),
      })
      .strict(),
    independent: z
      .object({
        decision: DecisionSchema,
        action: z.literal('keep_observe'),
      })
      .strict(),
    outcome: z.enum(['agreement', 'disagreement']),
    adjudication: AdjudicationSchema.optional(),
  })
  .strict();

export const IndependentAdjudicationReportSchema = z
  .object({
    kind: z.literal('f267-independent-adjudication-report'),
    schemaVersion: z.literal(1),
    reportId: z.string().min(1),
    cohort: z
      .object({
        ref: z.string().min(1),
        sha256: Sha256Schema,
      })
      .strict(),
    independentJudgment: z
      .object({
        ref: z.string().min(1),
        sha256: Sha256Schema,
      })
      .strict(),
    baselineProcedureVersionSetHash: Sha256Schema,
    items: z.array(ReportItemSchema),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        agreements: z.number().int().nonnegative(),
        disagreements: z.number().int().nonnegative(),
        agreementRate: z.number().gte(0).lte(1),
      })
      .strict(),
    coverage: z
      .object({
        observedDecisionClass: z.literal('no_opportunity_recall_null_downstream_degraded'),
        supportsRepeatability: z.literal(true),
        supportsCalibration: z.literal(false),
        supportsDiscrimination: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type IndependentAdjudicationReport = z.infer<typeof IndependentAdjudicationReportSchema>;
type ReportAdjudication = z.infer<typeof AdjudicationSchema>;

export interface IndependentAdjudicationInput {
  reportId: string;
  cohort: CheckedArtifact;
  rubric: CheckedArtifact;
  independentJudgment: CheckedArtifact;
  returnedPayloadBytes: Uint8Array;
  baselineProcedureVersionSetHash: string;
  baselineRows: Array<{ itemId: string; decision: 'usable' | 'insufficient'; action: string }>;
  adjudications: Array<ReportAdjudication & { itemId: string }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function assertExactSequence(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} mismatch`);
  }
}

function assertSafeReportRefs(report: IndependentAdjudicationReport): void {
  if (!/^docs\/harness-feedback\/rejudge-cohorts\/[^/]+\.yaml$/.test(report.cohort.ref)) {
    throw new Error('unsafe cohort ref in adjudication report');
  }
  if (!/^docs\/harness-feedback\/independent-judgments\/[^/]+\.yaml$/.test(report.independentJudgment.ref)) {
    throw new Error('unsafe independent judgment ref in adjudication report');
  }
}

function expectedMismatchReasons(item: IndependentAdjudicationReport['items'][number]): string[] {
  const reasons: string[] = [];
  if (item.baseline.action !== item.independent.action) reasons.push('baseline_action_mismatch');
  if (item.baseline.decision !== item.independent.decision) reasons.push('baseline_decision_mismatch');
  return reasons.sort();
}

function assertMismatchReasons(
  item: IndependentAdjudicationReport['items'][number],
  expectedReasons: readonly string[],
): void {
  const reasonCodes = item.adjudication?.reasonCodes ?? [];
  for (const reason of expectedReasons) {
    if (!reasonCodes.includes(reason as 'baseline_decision_mismatch' | 'baseline_action_mismatch')) {
      throw new Error(`missing ${reason} for ${item.itemId}`);
    }
  }
  for (const reason of ['baseline_action_mismatch', 'baseline_decision_mismatch'] as const) {
    if (reasonCodes.includes(reason) && !expectedReasons.includes(reason)) {
      throw new Error(`spurious ${reason} for ${item.itemId}`);
    }
  }
}

function assertIndependentPreference(item: IndependentAdjudicationReport['items'][number]): void {
  if (
    item.adjudication?.reasonCodes.includes('independent_evidence_preferred') &&
    (item.adjudication.finalDecision !== item.independent.decision ||
      item.adjudication.finalAction !== item.independent.action)
  ) {
    throw new Error(`independent evidence preference does not match final row for ${item.itemId}`);
  }
}

function assertAdjudication(item: IndependentAdjudicationReport['items'][number]): void {
  const expectedOutcome =
    item.baseline.decision === item.independent.decision && item.baseline.action === item.independent.action
      ? 'agreement'
      : 'disagreement';
  if (item.outcome !== expectedOutcome) throw new Error(`row-derived outcome mismatch for ${item.itemId}`);
  if (expectedOutcome === 'agreement') {
    if (item.adjudication) throw new Error(`agreement item ${item.itemId} cannot carry adjudication`);
    return;
  }
  if (!item.adjudication) throw new Error(`disagreement item ${item.itemId} requires adjudication`);

  unique(item.adjudication.reasonCodes, `adjudication reasons for ${item.itemId}`);
  assertExactSequence(
    item.adjudication.reasonCodes,
    [...item.adjudication.reasonCodes].sort(),
    `adjudication reason order for ${item.itemId}`,
  );
  const expectedReasons = expectedMismatchReasons(item);
  assertMismatchReasons(item, expectedReasons);
  assertIndependentPreference(item);
}

export function validateIndependentAdjudicationReport(input: unknown): IndependentAdjudicationReport {
  const report = IndependentAdjudicationReportSchema.parse(input);
  assertSafeReportRefs(report);
  const itemIds = report.items.map((item) => item.itemId);
  unique(itemIds, 'adjudication report item ids');
  assertExactSequence(itemIds, [...itemIds].sort(), 'adjudication report item order');
  for (const item of report.items) assertAdjudication(item);

  const agreements = report.items.filter((item) => item.outcome === 'agreement').length;
  const total = report.items.length;
  const expectedSummary = {
    total,
    agreements,
    disagreements: total - agreements,
    agreementRate: total === 0 ? 0 : agreements / total,
  };
  if (!isDeepStrictEqual(report.summary, expectedSummary)) throw new Error('adjudication report summary mismatch');
  return report;
}

function parseIndependentJudgment(artifact: CheckedArtifact): IndependentRejudge {
  const parsed = parse(Buffer.from(artifact.bytes).toString('utf8'));
  if (artifact.value !== undefined && !isDeepStrictEqual(artifact.value, parsed)) {
    throw new Error('independent judgment parsed value does not match exact artifact bytes');
  }
  return parsed as IndependentRejudge;
}

export function buildIndependentAdjudicationReport(input: IndependentAdjudicationInput): IndependentAdjudicationReport {
  unique(
    input.adjudications.map((item) => item.itemId),
    'input adjudication item ids',
  );
  const judgment = parseIndependentJudgment(input.independentJudgment);
  validateIndependentRejudge(judgment, {
    cohort: input.cohort,
    rubric: input.rubric,
    returnedPayloadBytes: input.returnedPayloadBytes,
    baselineProcedureVersionSetHash: input.baselineProcedureVersionSetHash,
  });

  const independentIds = judgment.terraReturn.payload.items.map((item) => item.itemId);
  const baselineIds = input.baselineRows.map((item) => item.itemId);
  unique(baselineIds, 'baseline row item ids');
  assertExactSequence(baselineIds, independentIds, 'baseline row coverage');

  const items: IndependentAdjudicationReport['items'] = judgment.terraReturn.payload.items.map((independent, index) => {
    const baseline = input.baselineRows[index];
    const outcome =
      baseline.decision === independent.decision && baseline.action === independent.action
        ? 'agreement'
        : 'disagreement';
    const provided = input.adjudications.find((item) => item.itemId === independent.itemId);
    const adjudication = provided
      ? {
          finalDecision: provided.finalDecision,
          finalAction: provided.finalAction,
          reasonCodes: provided.reasonCodes,
        }
      : undefined;
    return {
      itemId: independent.itemId,
      baseline: { decision: baseline.decision, action: baseline.action },
      independent: { decision: independent.decision, action: independent.action },
      outcome,
      ...(adjudication ? { adjudication } : {}),
    };
  });
  const usedAdjudicationIds = new Set(items.filter((item) => item.adjudication).map((item) => item.itemId));
  if (input.adjudications.some((item) => !usedAdjudicationIds.has(item.itemId))) {
    throw new Error('adjudication references an unknown item');
  }

  const agreements = items.filter((item) => item.outcome === 'agreement').length;
  return validateIndependentAdjudicationReport({
    kind: 'f267-independent-adjudication-report',
    schemaVersion: 1,
    reportId: input.reportId,
    cohort: { ref: judgment.cohort.ref, sha256: judgment.cohort.sha256 },
    independentJudgment: { ref: input.independentJudgment.ref, sha256: sha256(input.independentJudgment.bytes) },
    baselineProcedureVersionSetHash: input.baselineProcedureVersionSetHash,
    items,
    summary: {
      total: items.length,
      agreements,
      disagreements: items.length - agreements,
      agreementRate: items.length === 0 ? 0 : agreements / items.length,
    },
    coverage: {
      observedDecisionClass: 'no_opportunity_recall_null_downstream_degraded',
      supportsRepeatability: true,
      supportsCalibration: false,
      supportsDiscrimination: false,
    },
  });
}
