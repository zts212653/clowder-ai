// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMeasurementCertificateFixture } from './helpers/measurement-certificate-fixture.js';

const SHA = 'a'.repeat(64);

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/domain-negative-control.js');
}

async function certificate() {
  const value = await createMeasurementCertificateFixture({
    certificateId: 'f267-freshness-source-bound-negative-control-v1',
    bundleId: 'eval:freshness/source-bound-negative-control',
    domainId: 'eval:freshness',
    measurementTargetId: 'freshness_source_bound_negative_control_validity',
  });
  value.metrics = [
    {
      id: 'negative_control_gap_rate',
      role: 'primary_loss',
      description: 'Share of frozen challenge windows that reproduce a validity-blocking observation.',
      owner: 'F267 validity migration',
      estimator: 'challenge windows with a reproduced blocking observation / challenge windows',
      goodDirection: 'lower',
    },
    {
      id: 'cohort_case_coverage',
      role: 'guardrail',
      description: 'Share of selected source-bound cohort cases present in the deterministic reconstruction.',
      owner: 'F267 validity migration',
      estimator: 'reconstructed selected cases / selected cases',
      goodDirection: 'higher',
    },
  ];
  return value;
}

function cohort() {
  return {
    kind: 'f267-domain-negative-control-cohort',
    schemaVersion: 1,
    cohortId: 'f267-freshness-source-bound-v1',
    domainId: 'eval:freshness',
    measurementTargetId: 'freshness_source_bound_negative_control_validity',
    cases: [
      {
        caseId: 'reference-live-window',
        role: 'reference_window',
        snapshotRef: 'docs/harness-feedback/bundles/reference/snapshot.json',
        snapshotSha256: SHA,
        verdictRef: 'docs/harness-feedback/verdicts/reference.md',
        verdictSha256: SHA,
        supportingArtifacts: [],
        window: {
          startMs: 100,
          endMs: 200,
          source: {
            kind: 'numeric_json_pointer',
            startMsPointer: '/window/startMs',
            endMsPointer: '/window/endMs',
          },
        },
        observation: {
          verdict: 'keep_observe',
          values: [{ metricId: 'live_samples', jsonPointer: '/components/0/activationCounts/live_samples', value: 12 }],
        },
        blockingObservations: [],
      },
      {
        caseId: 'fixture-green-without-live-samples',
        role: 'negative_control',
        snapshotRef: 'docs/harness-feedback/bundles/challenge/snapshot.json',
        snapshotSha256: SHA,
        verdictRef: 'docs/harness-feedback/verdicts/challenge.md',
        verdictSha256: SHA,
        supportingArtifacts: [
          {
            ref: 'docs/bug-report/freshness-incident.md',
            sha256: SHA,
            requiredLiterals: ['provider denominator missed the completed carrier'],
          },
        ],
        window: {
          startMs: 300,
          endMs: 400,
          source: {
            kind: 'generated_at_duration_hours_json_pointer',
            generatedAtPointer: '/generatedAt',
            durationHoursPointer: '/window/durationHours',
          },
        },
        observation: {
          verdict: 'keep_observe',
          values: [
            { metricId: 'fixture_samples', jsonPointer: '/components/0/activationCounts/fixture_samples', value: 8 },
            { metricId: 'live_samples', jsonPointer: '/components/0/activationCounts/live_samples', value: 0 },
          ],
        },
        blockingObservations: [
          {
            metricId: 'live_samples',
            operator: 'eq',
            threshold: 0,
            reason: 'fixture_only_window_has_no_live_freshness_closure_sample',
            withdrawalCondition: 'capture at least one source-bound live freshness closure sample',
          },
        ],
      },
    ],
  };
}

describe('F267 source-bound domain negative-control contract', () => {
  it('turns a reproduced challenge into normalized insufficient + keep_observe evidence', async () => {
    const mod = await moduleUnderTest();
    const result = mod.buildDomainNegativeControlResult(cohort(), await certificate(), {
      resultId: 'f267-freshness-source-bound-negative-control-v1',
      certificateRef: 'docs/harness-feedback/certificates/f267-freshness.yaml',
      cohortRef: 'docs/harness-feedback/negative-controls/f267-freshness-v1.yaml',
      cohortSha256: SHA,
      generatedAt: '2026-08-10T12:00:00.000Z',
    });

    assert.equal(result.decision.status, 'insufficient');
    assert.deepEqual(result.decision.reasons, ['fixture_only_window_has_no_live_freshness_closure_sample']);
    assert.equal(result.actionProposal.action, 'keep_observe');
    assert.equal(result.metrics.find((metric) => metric.metricId === 'negative_control_gap_rate')?.pointEstimate, 1);
    assert.equal(result.metrics.find((metric) => metric.metricId === 'cohort_case_coverage')?.pointEstimate, 1);
  });

  it('rejects a challenge whose pinned observation does not reproduce its blocking condition', async () => {
    const mod = await moduleUnderTest();
    const input = cohort();
    input.cases[1].observation.values[1].value = 1;
    const cert = await certificate();
    assert.throws(
      () =>
        mod.buildDomainNegativeControlResult(input, cert, {
          resultId: 'drifted',
          certificateRef: 'docs/harness-feedback/certificates/f267-freshness.yaml',
          cohortRef: 'docs/harness-feedback/negative-controls/f267-freshness-v1.yaml',
          cohortSha256: SHA,
          generatedAt: '2026-08-10T12:00:00.000Z',
        }),
      /blocking observation does not reproduce/i,
    );
  });

  it('rejects duplicate source refs, empty windows, and blockers on reference windows', async () => {
    const mod = await moduleUnderTest();

    const duplicate = cohort();
    duplicate.cases[1].snapshotRef = duplicate.cases[0].snapshotRef;
    assert.throws(() => mod.parseDomainNegativeControlCohort(duplicate), /snapshot refs must be unique/i);

    const empty = cohort();
    empty.cases[1].window.startMs = empty.cases[1].window.endMs;
    assert.throws(() => mod.parseDomainNegativeControlCohort(empty), /window is empty/i);

    const blockerOnReference = cohort();
    blockerOnReference.cases[0].blockingObservations = blockerOnReference.cases[1].blockingObservations;
    assert.throws(() => mod.parseDomainNegativeControlCohort(blockerOnReference), /reference window cannot/i);
  });

  it('rejects a certificate for another domain or measurement target', async () => {
    const mod = await moduleUnderTest();
    const wrong = await certificate();
    wrong.measurementTarget.id = 'another_target';
    assert.throws(
      () =>
        mod.buildDomainNegativeControlResult(cohort(), wrong, {
          resultId: 'wrong-certificate',
          certificateRef: 'docs/harness-feedback/certificates/f267-freshness.yaml',
          cohortRef: 'docs/harness-feedback/negative-controls/f267-freshness-v1.yaml',
          cohortSha256: SHA,
          generatedAt: '2026-08-10T12:00:00.000Z',
        }),
      /does not match its measurement certificate/i,
    );
  });
});
