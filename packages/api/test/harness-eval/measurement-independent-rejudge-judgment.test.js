// @ts-check

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const cohortRef = 'docs/harness-feedback/rejudge-cohorts/f267-friction-2026-07-18-to-24.yaml';
const rubricRef = 'docs/harness-feedback/rejudge-rubrics/f267-friction-blind-sufficiency-v1.yaml';
const certificateRef = 'docs/harness-feedback/certificates/f267-friction-opportunity-to-action.yaml';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readYaml(ref) {
  return parse(readFileSync(resolve(repoRoot, ref), 'utf8'));
}

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-independent-rejudge.js');
}

function mutate(value, change) {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

describe('F267 independent blind rejudge judgment', () => {
  it('binds judge, model, rubric, canonical return bytes, item coverage, and keep_observe', async () => {
    const {
      canonicalizeIndependentRejudgePayload,
      computeIndependentRejudgeProcedureVersionSetHash,
      validateIndependentRejudge,
    } = await moduleUnderTest();
    const cohortBytes = readFileSync(resolve(repoRoot, cohortRef));
    const cohort = parse(cohortBytes.toString('utf8'));
    const rubricBytes = readFileSync(resolve(repoRoot, rubricRef));
    const rubric = parse(rubricBytes.toString('utf8'));
    const rubricSha256 = sha256(rubricBytes);
    const cohortSha256 = sha256(cohortBytes);
    const procedureVersionSetHash = computeIndependentRejudgeProcedureVersionSetHash({
      rubricRef,
      rubricSha256,
    });
    const baselineProcedureVersionSetHash = readYaml(certificateRef).decisionProcedure.versionSetHash;
    const payload = {
      cohortSha256,
      rubricSha256,
      procedureVersionSetHash,
      model: { provider: 'openai', modelId: 'gpt-5.6-terra', version: 'gpt-5.6-terra' },
      judgedAt: '2026-07-27T00:30:00.000Z',
      items: cohort.items.map((item) => ({
        itemId: item.itemId,
        cancelEvidence: 'not_estimable',
        downstreamEvidence: 'insufficient',
        decision: 'insufficient',
        action: 'keep_observe',
        reasonCodes: ['cancel_no_opportunity', 'cancel_recall_not_estimable', 'downstream_degraded'],
      })),
    };
    const returnedPayloadBytes = Buffer.from(canonicalizeIndependentRejudgePayload(payload));
    const judgment = {
      kind: 'f267-independent-rejudge',
      schemaVersion: 1,
      judgmentId: 'f267-friction-2026-07-18-to-24-terra',
      cohort: { ref: cohortRef, sha256: cohortSha256 },
      procedure: {
        judgeCatId: 'codex-terra',
        model: { provider: 'openai', modelId: 'gpt-5.6-terra', version: 'gpt-5.6-terra' },
        rubricRef,
        rubricSha256,
        procedureVersionSetHash,
      },
      terraReturn: {
        provenance: {
          sourceThreadId: 'thread_mrqepow7eugwx5jr',
          sourceMessageId: 'message-terra-return',
          sourceInvocationId: 'invocation-terra-return',
          returnedPayloadSha256: sha256(returnedPayloadBytes),
        },
        returnedPayloadUtf8: returnedPayloadBytes.toString('utf8'),
        payload,
      },
    };
    const context = {
      cohort: { ref: cohortRef, bytes: cohortBytes, value: cohort },
      rubric: { ref: rubricRef, bytes: rubricBytes, value: rubric },
      returnedPayloadBytes,
      baselineProcedureVersionSetHash,
    };

    assert.deepEqual(validateIndependentRejudge(judgment, context), judgment);

    const wrongJudge = mutate(judgment, (copy) => {
      copy.procedure.judgeCatId = 'codex-sol';
    });
    assert.throws(() => validateIndependentRejudge(wrongJudge, context));

    const wrongModel = mutate(judgment, (copy) => {
      copy.procedure.model.modelId = 'gpt-5.6-sol';
    });
    assert.throws(() => validateIndependentRejudge(wrongModel, context));

    const payloadModelMismatch = mutate(judgment, (copy) => {
      copy.terraReturn.payload.model.version = 'other';
    });
    assert.throws(() => validateIndependentRejudge(payloadModelMismatch, context));

    const unsafeRubric = mutate(judgment, (copy) => {
      copy.procedure.rubricRef = '../rubric.yaml';
    });
    assert.throws(() => validateIndependentRejudge(unsafeRubric, context), /rubric/i);

    assert.throws(
      () =>
        validateIndependentRejudge(judgment, {
          ...context,
          baselineProcedureVersionSetHash: procedureVersionSetHash,
        }),
      /baseline/i,
    );

    const missingProvenance = mutate(judgment, (copy) => {
      copy.terraReturn.provenance.sourceMessageId = '';
    });
    assert.throws(() => validateIndependentRejudge(missingProvenance, context));

    const hashDrift = mutate(judgment, (copy) => {
      copy.terraReturn.provenance.returnedPayloadSha256 = 'a'.repeat(64);
    });
    assert.throws(() => validateIndependentRejudge(hashDrift, context), /payload hash/i);

    const nonCanonicalBytes = Buffer.from(`${returnedPayloadBytes.toString('utf8')}\n`);
    assert.throws(
      () =>
        validateIndependentRejudge(
          mutate(judgment, (copy) => {
            copy.terraReturn.provenance.returnedPayloadSha256 = sha256(nonCanonicalBytes);
            copy.terraReturn.returnedPayloadUtf8 = nonCanonicalBytes.toString('utf8');
          }),
          { ...context, returnedPayloadBytes: nonCanonicalBytes },
        ),
      /canonical/i,
    );

    const missingItem = mutate(judgment, (copy) => {
      copy.terraReturn.payload.items.pop();
    });
    assert.throws(() => validateIndependentRejudge(missingItem, context), /item/i);

    const extraItem = mutate(judgment, (copy) => {
      copy.terraReturn.payload.items.push({ ...copy.terraReturn.payload.items[0], itemId: 'item-999' });
    });
    assert.throws(() => validateIndependentRejudge(extraItem, context), /item/i);

    const duplicateItem = mutate(judgment, (copy) => {
      copy.terraReturn.payload.items[1].itemId = copy.terraReturn.payload.items[0].itemId;
    });
    assert.throws(() => validateIndependentRejudge(duplicateItem, context), /item/i);

    const emptyReasons = mutate(judgment, (copy) => {
      copy.terraReturn.payload.items[0].reasonCodes = [];
    });
    assert.throws(() => validateIndependentRejudge(emptyReasons, context));

    const duplicateReasons = mutate(judgment, (copy) => {
      copy.terraReturn.payload.items[0].reasonCodes = ['cancel_no_opportunity', 'cancel_no_opportunity'];
    });
    assert.throws(() => validateIndependentRejudge(duplicateReasons, context), /reason/i);

    const unknownReason = mutate(judgment, (copy) => {
      copy.terraReturn.payload.items[0].reasonCodes = ['unknown'];
    });
    assert.throws(() => validateIndependentRejudge(unknownReason, context));

    const baselineReason = mutate(judgment, (copy) => {
      copy.terraReturn.payload.items[0].reasonCodes = ['baseline_decision_mismatch'];
    });
    assert.throws(() => validateIndependentRejudge(baselineReason, context));

    const actionBypass = mutate(judgment, (copy) => {
      copy.terraReturn.payload.items[0].action = 'fix';
    });
    assert.throws(() => validateIndependentRejudge(actionBypass, context));

    const falseUsable = mutate(judgment, (copy) => {
      copy.terraReturn.payload.items[0].decision = 'usable';
    });
    assert.throws(() => validateIndependentRejudge(falseUsable, context), /decision/i);
  });
});
