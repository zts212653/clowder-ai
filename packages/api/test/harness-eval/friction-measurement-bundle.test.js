// @ts-check

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const cohortRef =
  'docs/harness-feedback/bundles/2026-07-18-eval-friction-manual-recheck-rolling-window-toolgap-watch/raw/measurement-validity.json';
const certificateRef = 'docs/harness-feedback/certificates/f267-friction-opportunity-to-action.yaml';
const resultRef = 'docs/harness-feedback/measurement-results/f267-friction-2026-07-18.yaml';
const replayRef = 'docs/harness-feedback/replays/f267-friction-2026-07-18-same-version.yaml';

function readJson(ref) {
  return JSON.parse(readFileSync(resolve(repoRoot, ref), 'utf8'));
}

function readYaml(ref) {
  return parse(readFileSync(resolve(repoRoot, ref), 'utf8'));
}

function sha256(ref) {
  return createHash('sha256')
    .update(readFileSync(resolve(repoRoot, ref)))
    .digest('hex');
}

async function modulesUnderTest() {
  const [friction, replay, validation] = await Promise.all([
    import('../../dist/infrastructure/harness-eval/measurement/friction-measurement-bundle.js'),
    import('../../dist/infrastructure/harness-eval/measurement/measurement-replay.js'),
    import('../../dist/infrastructure/harness-eval/measurement/measurement-bundle-validation.js'),
  ]);
  return { ...friction, ...replay, ...validation };
}

describe('F267 friction bundle dogfood and same-version replay', () => {
  it('projects the accepted Phase A cohort without turning no opportunity into health', async () => {
    const { buildFrictionMeasurementBundleResult, parseMeasurementBundleCertificate, validateMeasurementBundleResult } =
      await modulesUnderTest();
    const certificate = parseMeasurementBundleCertificate(readYaml(certificateRef));
    const projected = buildFrictionMeasurementBundleResult(readJson(cohortRef), certificate, {
      resultId: 'f267-friction-2026-07-18',
      certificateRef,
      cohortRef,
      cohortSha256: sha256(cohortRef),
      generatedAt: '2026-07-19T17:00:00Z',
    });
    const result = validateMeasurementBundleResult(certificate, projected);

    assert.deepEqual(result, readYaml(resultRef));
    assert.deepEqual(result.metrics[0], {
      metricId: 'cancel_adapter_recall',
      role: 'primary_loss',
      n: 0,
      pointEstimate: null,
      evidenceStatus: 'insufficient',
      uncertainty: { kind: 'not_estimable', reason: 'cancel_join:no_opportunity' },
    });
    assert.equal(result.decision.status, 'insufficient');
    assert.deepEqual(result.decision.reasons, ['cancel_join:no_opportunity', 'downstream_degraded']);
    assert.deepEqual(result.decision.withdrawalConditions, [
      'rerun_after_closed_window_with_cancel_opportunity',
      'rerun_after_downstream_dependencies_recover',
    ]);

    const serialized = JSON.stringify({ certificate, result });
    assert.doesNotMatch(serialized, /paw-feel:\d|cancel:\d|"(?:expectedIds|actualIds|sourceEvidence|symptom|rawRef)":/);
  });

  it('requires identical certificate, frozen cohort, and version set for same-version replay', async () => {
    const { buildFrictionMeasurementBundleResult, buildSameVersionReplayReport, validateMeasurementBundleResult } =
      await modulesUnderTest();
    const certificate = readYaml(certificateRef);
    const baseline = validateMeasurementBundleResult(certificate, readYaml(resultRef));
    const replayed = buildFrictionMeasurementBundleResult(readJson(cohortRef), certificate, {
      resultId: 'f267-friction-2026-07-18-replay',
      certificateRef,
      cohortRef,
      cohortSha256: sha256(cohortRef),
      generatedAt: '2026-07-19T17:05:00Z',
    });
    const report = buildSameVersionReplayReport(baseline, replayed, {
      reportId: 'f267-friction-2026-07-18-same-version',
      generatedAt: '2026-07-19T17:05:00Z',
    });

    assert.equal(report.outcome, 'exact_agreement');
    assert.deepEqual(report.differences, []);
    assert.notEqual(report.baselineResultId, report.replayResultId);
    assert.deepEqual(report, readYaml(replayRef));

    const wrongCohort = structuredClone(baseline);
    wrongCohort.cohort.sha256 = 'b'.repeat(64);
    assert.throws(() => buildSameVersionReplayReport(baseline, wrongCohort), /cohort/i);

    const wrongVersion = structuredClone(baseline);
    wrongVersion.decisionProcedureVersionSetHash = 'b'.repeat(64);
    assert.throws(() => buildSameVersionReplayReport(baseline, wrongVersion), /version set/i);

    const disagreement = structuredClone(baseline);
    disagreement.decision.reasons.push('independent_replay_disagreed');
    const compared = buildSameVersionReplayReport(baseline, disagreement);
    assert.equal(compared.outcome, 'disagreement');
    assert.deepEqual(
      compared.differences.map((difference) => difference.path),
      ['decision'],
    );
  });
});
