// @ts-check

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse, stringify } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const sourceMapRef = 'docs/harness-feedback/rejudge-source-maps/f267-friction-2026-07-18-to-24.yaml';
const cohortRef = 'docs/harness-feedback/rejudge-cohorts/f267-friction-2026-07-18-to-24.yaml';
const rubricRef = 'docs/harness-feedback/rejudge-rubrics/f267-friction-blind-sufficiency-v1.yaml';
const judgmentRef = 'docs/harness-feedback/independent-judgments/f267-friction-2026-07-18-to-24-terra.yaml';
const certificateRef = 'docs/harness-feedback/certificates/f267-friction-opportunity-to-action.yaml';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mutate(value, change) {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-independent-rejudge.js');
}

describe('F267 independent adjudication report', () => {
  it('derives outcomes from rows and enforces adjudication, action, summary, and coverage invariants', async () => {
    const {
      buildIndependentAdjudicationReport,
      buildFrictionBaselineRows,
      canonicalizeIndependentRejudgePayload,
      computeIndependentRejudgeProcedureVersionSetHash,
      validateIndependentAdjudicationReport,
    } = await moduleUnderTest();
    const cohortBytes = readFileSync(resolve(repoRoot, cohortRef));
    const rubricBytes = readFileSync(resolve(repoRoot, rubricRef));
    const sourceMapBytes = readFileSync(resolve(repoRoot, sourceMapRef));
    const cohort = parse(cohortBytes.toString('utf8'));
    const sourceMap = parse(sourceMapBytes.toString('utf8'));
    const rubricSha256 = sha256(rubricBytes);
    const cohortSha256 = sha256(cohortBytes);
    const procedureVersionSetHash = computeIndependentRejudgeProcedureVersionSetHash({
      rubricRef,
      rubricSha256,
    });
    const baselineProcedureVersionSetHash = parse(readFileSync(resolve(repoRoot, certificateRef), 'utf8'))
      .decisionProcedure.versionSetHash;
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
    const judgmentBytes = Buffer.from(stringify(judgment));
    const baselineRows = buildFrictionBaselineRows(
      { ref: sourceMapRef, bytes: sourceMapBytes, value: sourceMap },
      sourceMap.items.map((item) => ({
        itemId: item.itemId,
        ref: item.measurementSource.ref,
        bytes: readFileSync(resolve(repoRoot, item.measurementSource.ref)),
      })),
    );
    assert.deepEqual(
      baselineRows,
      cohort.items.map((item) => ({
        itemId: item.itemId,
        decision: 'insufficient',
        action: 'keep_observe',
      })),
    );
    const baseInput = {
      reportId: 'f267-friction-2026-07-18-to-24',
      cohort: { ref: cohortRef, bytes: cohortBytes, value: cohort },
      rubric: { ref: rubricRef, bytes: rubricBytes },
      independentJudgment: { ref: judgmentRef, bytes: judgmentBytes, value: judgment },
      returnedPayloadBytes,
      baselineProcedureVersionSetHash,
      baselineRows,
      adjudications: [],
    };

    const agreement = buildIndependentAdjudicationReport(baseInput);
    assert.deepEqual(agreement.summary, {
      total: 3,
      agreements: 3,
      disagreements: 0,
      agreementRate: 1,
    });
    assert.ok(agreement.items.every((item) => item.outcome === 'agreement' && !item.adjudication));
    assert.deepEqual(validateIndependentAdjudicationReport(agreement), agreement);

    const disagreementInput = mutate(baseInput, (copy) => {
      copy.baselineRows[0].decision = 'usable';
      copy.adjudications = [
        {
          itemId: 'item-001',
          finalDecision: 'insufficient',
          finalAction: 'keep_observe',
          reasonCodes: ['baseline_decision_mismatch', 'independent_evidence_preferred'],
        },
      ];
    });
    const disagreement = buildIndependentAdjudicationReport(disagreementInput);
    assert.equal(disagreement.items[0].outcome, 'disagreement');
    assert.deepEqual(disagreement.items[0].adjudication.reasonCodes, [
      'baseline_decision_mismatch',
      'independent_evidence_preferred',
    ]);
    assert.deepEqual(disagreement.items[0].independent, {
      decision: 'insufficient',
      action: 'keep_observe',
    });
    assert.deepEqual(disagreement.summary, {
      total: 3,
      agreements: 2,
      disagreements: 1,
      agreementRate: 2 / 3,
    });

    assert.throws(
      () =>
        buildIndependentAdjudicationReport(
          mutate(disagreementInput, (copy) => {
            copy.adjudications = [];
          }),
        ),
      /adjudication/i,
    );

    for (const reasonCodes of [
      [],
      ['baseline_decision_mismatch', 'baseline_decision_mismatch'],
      ['unknown'],
      ['cancel_no_opportunity'],
    ]) {
      assert.throws(() =>
        buildIndependentAdjudicationReport(
          mutate(disagreementInput, (copy) => {
            copy.adjudications[0].reasonCodes = reasonCodes;
          }),
        ),
      );
    }

    assert.throws(() =>
      buildIndependentAdjudicationReport(
        mutate(disagreementInput, (copy) => {
          copy.adjudications[0].finalAction = 'fix';
        }),
      ),
    );

    assert.throws(
      () =>
        validateIndependentAdjudicationReport(
          mutate(agreement, (copy) => {
            copy.summary.agreements = 2;
          }),
        ),
      /summary/i,
    );
    assert.throws(() =>
      validateIndependentAdjudicationReport(
        mutate(agreement, (copy) => {
          copy.coverage.supportsCalibration = true;
        }),
      ),
    );
    assert.throws(
      () =>
        validateIndependentAdjudicationReport(
          mutate(disagreement, (copy) => {
            delete copy.items[0].adjudication;
          }),
        ),
      /adjudication/i,
    );
    assert.throws(
      () =>
        validateIndependentAdjudicationReport(
          mutate(agreement, (copy) => {
            copy.items[0].adjudication = {
              finalDecision: 'insufficient',
              finalAction: 'keep_observe',
              reasonCodes: ['independent_evidence_preferred'],
            };
          }),
        ),
      /agreement/i,
    );
  });
});
