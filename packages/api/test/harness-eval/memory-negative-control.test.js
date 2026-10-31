// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SHA = 'a'.repeat(64);

async function modules() {
  const [negativeControl, validation] = await Promise.all([
    import('../../dist/infrastructure/harness-eval/measurement/memory-negative-control.js'),
    import('../../dist/infrastructure/harness-eval/measurement/measurement-bundle-validation.js'),
  ]);
  return { negativeControl, validation };
}

function certificate(versionSetHash) {
  return {
    kind: 'f267-measurement-certificate',
    schemaVersion: 1,
    certificateId: 'f267-memory-search-quality-negative-control-v1',
    bundleId: 'eval:memory/search-quality-negative-control',
    domainId: 'eval:memory',
    status: 'issued',
    measurementTarget: {
      id: 'memory_search_quality_negative_control_validity',
      estimand: 'Whether three green windows and a real incident have a consistent, replayable evidence chain.',
      utilityClaim: 'A consistent contrast makes negative memory-health verdicts safer to consume.',
      unitOfAnalysis: 'frozen eval:memory verdict window',
    },
    decision: {
      consumerFeatureId: 'F200',
      consumerOwnerCatId: 'opus-47',
      allowedActions: ['keep_observe', 'fix', 'build', 'delete_sunset'],
      primaryQuestion: 'Can eval:memory search-quality evidence lawfully support an owner action?',
    },
    targetPopulation: {
      description: 'Committed eval:memory search-quality windows with source snapshots and verdict artifacts.',
      inclusion: ['three overlapping keep_observe windows', 'one subsequent real production incident'],
      exclusion: ['uncommitted runtime-only evidence'],
    },
    window: {
      boundary: 'half_open',
      selection: 'three ordered overlapping green windows plus the first pinned production incident comparison',
      maxDurationHours: 1440,
    },
    metrics: [
      {
        id: 'green_window_coverage',
        role: 'primary_loss',
        description: 'Share of selected green windows with non-empty search-quality opportunity coverage.',
        owner: 'F200 memory eval',
        estimator: 'covered green windows / selected green windows',
        goodDirection: 'higher',
      },
      {
        id: 'incident_detection_rate',
        role: 'guardrail',
        description: 'Share of selected production incidents that produced a non-green verdict.',
        owner: 'F200 memory eval',
        estimator: 'non-green incident verdicts / selected incidents',
        goodDirection: 'higher',
      },
      {
        id: 'incident_evidence_consistency',
        role: 'guardrail',
        description: 'Share of incident cases whose checked snapshot reproduces the pinned incident truth.',
        owner: 'F267 validity checker',
        estimator: 'consistent incident cases / selected incidents',
        goodDirection: 'higher',
      },
    ],
    errorCosts: {
      falsePositive: 'Block a valid memory verdict until its source bundle is repaired.',
      falseNegative: 'Allow a false-green memory verdict to drive action from a broken sensor.',
    },
    validityBounds: [
      'Incident truth must be pinned to committed first-party evidence.',
      'The checked snapshot must reproduce the incident observation surface.',
    ],
    sampleContract: {
      unit: 'committed verdict window',
      inclusion: 'Exactly three green cases and one incident case in chronological order.',
      exclusion: 'No prose-only case without pinned snapshot and verdict hashes.',
      missingness: 'Any missing or inconsistent source makes the overall decision insufficient.',
    },
    uncertainty: {
      method: 'exact frozen-case reconciliation',
      requiredEvidence: { n: true, pointEstimate: true, intervalOrPower: true },
      insufficientWhen: ['fewer than three green windows', 'incident evidence mismatch', 'source hash drift'],
    },
    calibrationPlan: {
      reference: 'independent review of frozen source refs and incident classification',
      cadence: 'each negative-control cohort and after judge/source schema changes',
      failureThreshold: 'any incident evidence inconsistency',
      action: 'withdraw the result and keep_observe until a reproducible source bundle exists',
    },
    withdrawalConditions: ['source ref/hash drift', 'incident truth cannot be independently reopened'],
    interventionPolicy: { requiredFor: ['fix', 'build', 'delete_sunset'] },
    decisionProcedure: {
      artifactRevision: 'b'.repeat(40),
      components: ['judge', 'rubric', 'classifier', 'prompt', 'model', 'code'].map((kind) => ({
        kind,
        name: `memory-${kind}`,
        version: 'v1',
        artifactRef: `docs/${kind}.md`,
        artifactSha256: SHA,
      })),
      versionSetHash,
    },
    repeatabilityContract: {
      stage: 'decision',
      frozenCohortContract: 'identical source refs, hashes, extracted observations, and incident truth',
      minimumRuns: 2,
      allowedVariation: 'resultId and generatedAt only',
      tolerance: 'exact agreement on metrics, decision, and action proposal',
    },
    provenance: {
      featureId: 'F267',
      sourceRevision: 'b'.repeat(40),
      generatedAt: '2026-08-01T12:00:00.000Z',
    },
  };
}

function cohort() {
  const green = [
    ['green-2026-07-07', 1780801438219, 1783393438219],
    ['green-2026-07-17', 1781665364323, 1784257364323],
    ['green-2026-07-23', 1782184581121, 1784776581121],
  ].map(([caseId, startMs, endMs]) => ({
    caseId,
    role: 'green_window',
    snapshotRef: `docs/harness-feedback/bundles/${caseId}/snapshot.json`,
    snapshotSha256: SHA,
    verdictRef: `docs/harness-feedback/verdicts/${caseId}.md`,
    verdictSha256: SHA,
    window: { startMs, endMs },
    observation: { verdict: 'keep_observe', totalSearches: 200, observedSearches: 200 },
  }));
  return {
    kind: 'f267-memory-negative-control-cohort',
    schemaVersion: 1,
    cohortId: 'f267-memory-search-quality-v1',
    domainId: 'eval:memory',
    cases: [
      ...green,
      {
        caseId: 'incident-2026-08-01-origin-migration',
        role: 'production_incident',
        snapshotRef: 'docs/harness-feedback/bundles/incident/snapshot.json',
        snapshotSha256: SHA,
        verdictRef: 'docs/harness-feedback/verdicts/incident.md',
        verdictSha256: SHA,
        window: { startMs: 1782961475275, endMs: 1785553475275 },
        observation: { verdict: 'fix', totalSearches: 200, observedSearches: 200 },
        incidentTruth: {
          officialObservedSearches: 0,
          underlyingSearchLogRows: 32258,
          directObservedSearches: 200,
        },
      },
    ],
  };
}

describe('F267 memory negative-control evaluator', () => {
  it('turns a real incident/snapshot mismatch into insufficient + keep_observe', async () => {
    const { negativeControl, validation } = await modules();
    const components = certificate('').decisionProcedure.components;
    const versionSetHash = validation.computeDecisionProcedureVersionSetHash(components);
    const result = negativeControl.buildMemoryNegativeControlResult(cohort(), certificate(versionSetHash), {
      resultId: 'f267-memory-search-quality-negative-control-v1',
      certificateRef: 'docs/harness-feedback/certificates/f267-memory-search-quality.yaml',
      cohortRef: 'docs/harness-feedback/negative-controls/f267-memory-search-quality-v1.yaml',
      cohortSha256: SHA,
      generatedAt: '2026-08-01T12:05:00.000Z',
    });

    assert.equal(result.decision.status, 'insufficient');
    assert.equal(result.actionProposal.action, 'keep_observe');
    assert.equal(result.metrics.find((metric) => metric.metricId === 'green_window_coverage')?.pointEstimate, 1);
    assert.equal(result.metrics.find((metric) => metric.metricId === 'incident_detection_rate')?.pointEstimate, 1);
    assert.equal(
      result.metrics.find((metric) => metric.metricId === 'incident_evidence_consistency')?.pointEstimate,
      0,
    );
  });

  it('rejects fewer than three green windows and non-overlapping green windows', async () => {
    const { negativeControl } = await modules();
    const tooThin = cohort();
    tooThin.cases.splice(1, 1);
    assert.throws(() => negativeControl.parseMemoryNegativeControlCohort(tooThin), /three green/i);

    const discontinuous = cohort();
    discontinuous.cases[1].window.startMs = discontinuous.cases[0].window.endMs + 1;
    assert.throws(() => negativeControl.parseMemoryNegativeControlCohort(discontinuous), /continuous|overlap/i);
  });

  it('can become usable only when the pinned incident truth and snapshot agree', async () => {
    const { negativeControl, validation } = await modules();
    const consistent = cohort();
    consistent.cases[3].observation.observedSearches = 0;
    const components = certificate('').decisionProcedure.components;
    const versionSetHash = validation.computeDecisionProcedureVersionSetHash(components);
    const result = negativeControl.buildMemoryNegativeControlResult(consistent, certificate(versionSetHash), {
      resultId: 'consistent',
      certificateRef: 'docs/harness-feedback/certificates/f267-memory-search-quality.yaml',
      cohortRef: 'docs/harness-feedback/negative-controls/f267-memory-search-quality-v1.yaml',
      cohortSha256: SHA,
      generatedAt: '2026-08-01T12:05:00.000Z',
    });
    assert.equal(result.decision.status, 'usable');
    assert.equal(
      result.metrics.find((metric) => metric.metricId === 'incident_evidence_consistency')?.pointEstimate,
      1,
    );
  });
});
