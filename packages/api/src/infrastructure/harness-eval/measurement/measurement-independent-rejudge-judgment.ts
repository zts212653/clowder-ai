import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { parse } from 'yaml';
import { z } from 'zod';

import { type FrozenRejudgeCohort, FrozenRejudgeCohortSchema } from './measurement-independent-rejudge-cohort.js';

const COHORT_REF = 'docs/harness-feedback/rejudge-cohorts/f267-friction-2026-07-18-to-24.yaml';
const RUBRIC_REF = 'docs/harness-feedback/rejudge-rubrics/f267-friction-blind-sufficiency-v1.yaml';
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const INDEPENDENT_REASON_CODES = [
  'cancel_no_opportunity',
  'cancel_recall_not_estimable',
  'downstream_degraded',
] as const;

const FixedTerraModelSchema = z
  .object({
    provider: z.literal('openai'),
    modelId: z.literal('gpt-5.6-terra'),
    version: z.literal('gpt-5.6-terra'),
  })
  .strict();

const IndependentReasonCodeSchema = z.enum(INDEPENDENT_REASON_CODES);

export const BlindRejudgeRubricSchema = z
  .object({
    kind: z.literal('f267-blind-rejudge-rubric'),
    schemaVersion: z.literal(1),
    rubricId: z.literal('f267-friction-blind-sufficiency-v1'),
    version: z.literal('1'),
    allowedEvidenceFields: z.array(z.string().min(1)).min(1),
    boundedReasonCodes: z.array(IndependentReasonCodeSchema),
    rules: z
      .object({
        zeroExpectedCount: z.literal('not_estimable'),
        downstreamDegraded: z.literal('insufficient'),
        insufficientAction: z.literal('keep_observe'),
      })
      .strict(),
  })
  .strict();

const IndependentRejudgePayloadItemSchema = z
  .object({
    itemId: z.string().regex(/^item-\d{3}$/),
    cancelEvidence: z.enum(['estimable', 'not_estimable']),
    downstreamEvidence: z.enum(['sufficient', 'insufficient']),
    decision: z.enum(['usable', 'insufficient']),
    action: z.literal('keep_observe'),
    reasonCodes: z.array(IndependentReasonCodeSchema).min(1),
  })
  .strict();

export const IndependentRejudgePayloadSchema = z
  .object({
    cohortSha256: Sha256Schema,
    rubricSha256: Sha256Schema,
    procedureVersionSetHash: Sha256Schema,
    model: FixedTerraModelSchema,
    judgedAt: z.string().datetime(),
    items: z.array(IndependentRejudgePayloadItemSchema),
  })
  .strict();

export const IndependentRejudgeSchema = z
  .object({
    kind: z.literal('f267-independent-rejudge'),
    schemaVersion: z.literal(1),
    judgmentId: z.string().min(1),
    cohort: z
      .object({
        ref: z.string().min(1),
        sha256: Sha256Schema,
      })
      .strict(),
    procedure: z
      .object({
        judgeCatId: z.literal('codex-terra'),
        model: FixedTerraModelSchema,
        rubricRef: z.string().min(1),
        rubricSha256: Sha256Schema,
        procedureVersionSetHash: Sha256Schema,
      })
      .strict(),
    terraReturn: z
      .object({
        provenance: z
          .object({
            sourceThreadId: z.string().min(1),
            sourceMessageId: z.string().min(1),
            sourceInvocationId: z.string().min(1),
            returnedPayloadSha256: Sha256Schema,
          })
          .strict(),
        returnedPayloadUtf8: z.string().min(1),
        payload: IndependentRejudgePayloadSchema,
      })
      .strict(),
  })
  .strict();

export type BlindRejudgeRubric = z.infer<typeof BlindRejudgeRubricSchema>;
export type IndependentRejudgePayload = z.infer<typeof IndependentRejudgePayloadSchema>;
export type IndependentRejudge = z.infer<typeof IndependentRejudgeSchema>;

export interface CheckedArtifact {
  ref: string;
  bytes: Uint8Array;
  value?: unknown;
}

export interface IndependentRejudgeValidationContext {
  cohort: CheckedArtifact;
  rubric: CheckedArtifact;
  returnedPayloadBytes: Uint8Array;
  baselineProcedureVersionSetHash: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique values`);
  }
}

function assertExactSequence(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} mismatch`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalizeIndependentRejudgePayload(input: unknown): string {
  return canonicalJson(IndependentRejudgePayloadSchema.parse(input));
}

export function computeIndependentRejudgeProcedureVersionSetHash(input: {
  rubricRef: string;
  rubricSha256: string;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        contract: 'f267-independent-rejudge-procedure-v1',
        judge: { catId: 'codex-terra' },
        model: { provider: 'openai', modelId: 'gpt-5.6-terra', version: 'gpt-5.6-terra' },
        rubric: { ref: input.rubricRef, sha256: input.rubricSha256 },
      }),
    )
    .digest('hex');
}

function parseCheckedYaml<T>(artifact: CheckedArtifact, expectedRef: string, schema: z.ZodType<T>, label: string): T {
  if (artifact.ref !== expectedRef) throw new Error(`${label} ref is unsafe or unexpected`);
  const parsed = schema.parse(parse(Buffer.from(artifact.bytes).toString('utf8')));
  if (artifact.value !== undefined && !isDeepStrictEqual(artifact.value, parsed)) {
    throw new Error(`${label} parsed value does not match exact artifact bytes`);
  }
  return parsed;
}

function assertRubric(rubric: BlindRejudgeRubric): void {
  unique(rubric.allowedEvidenceFields, 'rubric allowed evidence fields');
  unique(rubric.boundedReasonCodes, 'rubric reason codes');
  assertExactSequence(rubric.boundedReasonCodes, INDEPENDENT_REASON_CODES, 'rubric reason code vocabulary');
}

type CohortEvidence = FrozenRejudgeCohort['items'][number]['evidence'];
type JudgmentItem = IndependentRejudge['terraReturn']['payload']['items'][number];

function deriveEvidenceVerdict(evidence: CohortEvidence): {
  cancelEvidence: 'estimable' | 'not_estimable';
  downstreamEvidence: 'sufficient' | 'insufficient';
  decision: 'usable' | 'insufficient';
} {
  const cancelEvidence =
    evidence.cancel.expectedCount === 0 || evidence.cancel.recall === null ? 'not_estimable' : 'estimable';
  const downstreamEvidence = evidence.downstreamDegraded ? 'insufficient' : 'sufficient';
  const decision =
    cancelEvidence === 'not_estimable' || downstreamEvidence === 'insufficient' ? 'insufficient' : 'usable';
  return { cancelEvidence, downstreamEvidence, decision };
}

function assertReasonCodes(item: JudgmentItem, evidence: CohortEvidence, cancelEvidence: string): void {
  unique(item.reasonCodes, `reason codes for ${item.itemId}`);
  assertExactSequence(item.reasonCodes, [...item.reasonCodes].sort(), `reason code order for ${item.itemId}`);
  if (item.reasonCodes.includes('cancel_no_opportunity') && evidence.cancel.expectedCount !== 0) {
    throw new Error(`cancel_no_opportunity reason does not match ${item.itemId}`);
  }
  if (item.reasonCodes.includes('cancel_recall_not_estimable') && cancelEvidence !== 'not_estimable') {
    throw new Error(`cancel_recall_not_estimable reason does not match ${item.itemId}`);
  }
  if (item.reasonCodes.includes('downstream_degraded') && !evidence.downstreamDegraded) {
    throw new Error(`downstream_degraded reason does not match ${item.itemId}`);
  }
}

function assertItem(item: JudgmentItem, evidence: CohortEvidence): void {
  const derived = deriveEvidenceVerdict(evidence);
  if (item.cancelEvidence !== derived.cancelEvidence) {
    throw new Error(`cancel evidence mismatch for ${item.itemId}`);
  }
  if (item.downstreamEvidence !== derived.downstreamEvidence) {
    throw new Error(`downstream evidence mismatch for ${item.itemId}`);
  }
  if (item.decision !== derived.decision) throw new Error(`decision mismatch for ${item.itemId}`);
  assertReasonCodes(item, evidence, derived.cancelEvidence);
}

function assertItems(cohort: FrozenRejudgeCohort, judgment: IndependentRejudge): void {
  const expectedIds = cohort.items.map((item) => item.itemId);
  const actualIds = judgment.terraReturn.payload.items.map((item) => item.itemId);
  unique(actualIds, 'independent judgment item ids');
  assertExactSequence(actualIds, expectedIds, 'independent judgment item coverage');

  for (const [index, item] of judgment.terraReturn.payload.items.entries()) {
    assertItem(item, cohort.items[index].evidence);
  }
}

export function validateIndependentRejudge(
  input: unknown,
  context: IndependentRejudgeValidationContext,
): IndependentRejudge {
  const judgment = IndependentRejudgeSchema.parse(input);
  const cohort = parseCheckedYaml(context.cohort, COHORT_REF, FrozenRejudgeCohortSchema, 'cohort');
  const rubric = parseCheckedYaml(context.rubric, RUBRIC_REF, BlindRejudgeRubricSchema, 'rubric');
  assertRubric(rubric);

  const cohortSha256 = sha256(context.cohort.bytes);
  const rubricSha256 = sha256(context.rubric.bytes);
  if (judgment.cohort.ref !== context.cohort.ref || judgment.cohort.sha256 !== cohortSha256) {
    throw new Error('cohort ref or hash mismatch');
  }
  if (judgment.procedure.rubricRef !== context.rubric.ref || judgment.procedure.rubricSha256 !== rubricSha256) {
    throw new Error('rubric ref or hash mismatch');
  }

  const procedureVersionSetHash = computeIndependentRejudgeProcedureVersionSetHash({
    rubricRef: context.rubric.ref,
    rubricSha256,
  });
  if (procedureVersionSetHash === context.baselineProcedureVersionSetHash) {
    throw new Error('independent procedure version set must differ from baseline');
  }
  if (
    judgment.procedure.procedureVersionSetHash !== procedureVersionSetHash ||
    judgment.terraReturn.payload.procedureVersionSetHash !== procedureVersionSetHash
  ) {
    throw new Error('independent procedure version set hash mismatch');
  }
  if (
    judgment.terraReturn.payload.cohortSha256 !== cohortSha256 ||
    judgment.terraReturn.payload.rubricSha256 !== rubricSha256
  ) {
    throw new Error('returned cohort or rubric hash mismatch');
  }
  if (!isDeepStrictEqual(judgment.procedure.model, judgment.terraReturn.payload.model)) {
    throw new Error('payload model does not match the fixed procedure model');
  }

  assertItems(cohort, judgment);

  const returnedPayloadBytes = Buffer.from(context.returnedPayloadBytes);
  const returnedPayload = returnedPayloadBytes.toString('utf8');
  if (judgment.terraReturn.returnedPayloadUtf8 !== returnedPayload) {
    throw new Error('stored Terra return bytes do not match the checked payload bytes');
  }
  if (returnedPayload !== canonicalizeIndependentRejudgePayload(judgment.terraReturn.payload)) {
    throw new Error('Terra return is not canonical UTF-8 sorted-key JSON');
  }
  if (/baseline_(?:decision|action)_mismatch|independent_evidence_preferred/.test(returnedPayload)) {
    throw new Error('Terra return contains post-join adjudication vocabulary');
  }
  if (judgment.terraReturn.provenance.returnedPayloadSha256 !== sha256(returnedPayloadBytes)) {
    throw new Error('returned payload hash mismatch');
  }

  return judgment;
}
