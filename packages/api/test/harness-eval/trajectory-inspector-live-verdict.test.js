import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generateTrajectoryInspectorLiveVerdict } from '../../dist/infrastructure/harness-eval/trajectory-inspector/eval-trajectory-inspector-live-verdict.js';

const domain = {
  domainId: 'eval:trajectory-inspector',
  displayName: 'Invocation Trajectory Inspector Utility Eval',
  systemThreadId: 'thread_eval_trajectory_inspector',
  evalCat: { catId: 'codex-sol', handle: '@codex-sol', model: 'gpt-5.6-sol' },
  frequency: 'weekly',
  triggerPolicy: { mode: 'time_only', maxDetectionDelayHours: 168 },
  sourceAdapter: 'f299-trajectory-inspector-episodes',
  sourceRefsKind: 'trajectory-inspector-window',
  threadPolicy: { role: 'working-home', stateSot: 'registry', allowedContent: ['longitudinal-analysis'] },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F299', ownerCatId: 'fable5', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 336 },
  fixtures: [],
  enabled: true,
};

const metricRefs = [
  'metric:eligible_episodes',
  'metric:accepted_evidence_episodes',
  'metric:unresolved_evidence_episodes',
  'metric:not_taken_episodes',
  'metric:wrong_ref_episodes',
  'metric:time_to_first_accepted_evidence_ms',
  'metric:raw_or_jsonl_fallback_episodes',
  'metric:canonical_coverage',
  'metric:reviewer_disagreement_rate',
];

function packet(verdict = 'keep_observe') {
  return {
    id: `f299-trajectory-${verdict.replaceAll('_', '-')}`,
    domainId: 'eval:trajectory-inspector',
    findingKey: 'utility-window',
    createdAt: '2026-08-24T20:00:00.000Z',
    phenomenon: 'The first bounded real window is calibration-only.',
    harnessUnderEval: { featureId: 'F299', componentId: 'trajectory-inspector-utility', name: 'Inspector' },
    evidencePacket: {
      snapshotRefs: ['placeholder:snapshot'],
      attributionRefs: ['placeholder:attribution'],
      metricRefs,
      sampleTraceRefs: ['inv:inv-1'],
    },
    dailyTrend: {
      window: 'caller-authored-ignored',
      current: { opening_rate: 1 },
      baseline: { opening_rate: 0 },
      threshold: { opening_rate: 1 },
      direction: 'improved',
    },
    rootCauseHypothesis: {
      summary: 'The window lacks enough independently reviewed episodes.',
      confidence: 'high',
      alternatives: ['Anomaly mix may change in a later window.'],
    },
    verdict,
    ownerAsk: {
      targetFeatureId: 'F299',
      targetOwnerCatId: 'fable5',
      requestedAction: 'Keep observing with the same bounded selector.',
    },
    ...(verdict === 'delete_sunset' ? { governance: { cvoAcceptRequired: true } } : {}),
    acceptanceReevalPlan: {
      nextEvalAt: '2026-08-31T20:00:00.000Z',
      closureCondition: 'A later trusted verdict replays the same case with usable validity.',
    },
    counterarguments: ['The first window may undercount manual investigations.'],
  };
}

function episode(invocationId, outcome, overrides = {}) {
  return {
    episodeId: `trajectory:${invocationId}`,
    invocationId,
    threadId: 'thread-owner',
    sessionId: 'session-owner',
    eligibleAtMs: 1_000,
    eligibility: ['terminal_anomaly'],
    anomalyKind: 'error',
    firstAcceptedEvidenceAtMs: outcome === 'accepted' ? 1_400 : null,
    evidenceOutcome: outcome,
    rawOrJsonlFallback: outcome === 'unresolved',
    reviewerAgreement: outcome === 'accepted' ? 'agreed' : 'unreviewed',
    sourceRefs: [`inv:${invocationId}`, 'thread:thread-owner', 'session:session-owner'],
    ...overrides,
  };
}

function bundle(overrides = {}) {
  return {
    selector: { kind: 'trajectory-inspector-window', windowStartMs: 900, windowEndMs: 2_000 },
    sourceHealth: {
      canonicalResolvedEpisodes: 2,
      canonicalCandidateEpisodes: 2,
      missingTranscriptSessions: 0,
      significantModelRuntimeDrift: false,
      modelRuntimeFingerprints: ['unknown:unknown'],
      comparableBaseline: false,
    },
    episodes: [episode('inv-1', 'accepted'), episode('inv-2', 'unresolved')],
    vector: {
      eligibleEpisodes: 2,
      accepted: 1,
      unresolved: 1,
      notTaken: 0,
      wrongRef: 0,
      timeToFirstAcceptedEvidenceMs: [400],
      rawOrJsonlFallbackCount: 1,
    },
    validity: {
      status: 'calibration_only',
      reasons: ['fewer_than_10_eligible_episodes', 'comparable_baseline_unavailable'],
      canonicalCoverage: 1,
      reviewerDisagreementRate: 0,
    },
    stopUtilityConclusion: false,
    ...overrides,
  };
}

describe('trajectory inspector live verdict generator', () => {
  it('writes raw replay input, the exact vector, provenance, and a calibration-only handoff', () => {
    const root = mkdtempSync(join(tmpdir(), 'f299-trajectory-verdict-'));
    const artifact = generateTrajectoryInspectorLiveVerdict({
      verdictId: 'f299-trajectory-keep-observe',
      harnessFeedbackRoot: root,
      domain,
      episodeBundle: bundle(),
      submittedPacket: packet(),
      generatedAt: '2026-08-24T20:00:00.000Z',
      generatorCommit: 'a'.repeat(40),
    });

    const raw = JSON.parse(readFileSync(join(artifact.bundleDir, 'raw', 'episodes.json'), 'utf8'));
    const snapshot = JSON.parse(readFileSync(join(artifact.bundleDir, 'snapshot.json'), 'utf8'));
    const attribution = JSON.parse(readFileSync(join(artifact.bundleDir, 'attribution.json'), 'utf8'));
    const provenance = JSON.parse(readFileSync(join(artifact.bundleDir, 'provenance.json'), 'utf8'));
    assert.deepEqual(raw, bundle());
    assert.deepEqual(snapshot.trajectoryInspectorVector, bundle().vector);
    assert.deepEqual(snapshot.trajectoryInspectorCohort, { anomalyKinds: ['error'] });
    assert.equal(JSON.stringify(snapshot).includes('opening_rate'), false);
    assert.equal('score' in snapshot, false);
    assert.equal(provenance.rawInputs[0].sha256.length, 64);
    assert.equal(provenance.generator.commit, 'a'.repeat(40));
    assert.equal(artifact.packet.dailyTrend.current.eligible_episodes, 2);
    assert.equal('opening_rate' in artifact.packet.dailyTrend.current, false);
    assert.deepEqual(artifact.packet.evidencePacket.metricRefs, metricRefs);
    assert.match(artifact.markdown, /Validity: `calibration_only`/);
    assert.match(artifact.markdown, /no composite score/i);
    assert.equal(attribution.trajectoryInspectorEvidence[0].kind, 'f299-accepted-evidence');
  });

  it('rejects every actionable verdict unless validity, baseline, review, and canonical refs are usable', () => {
    const usable = bundle({
      sourceHealth: { ...bundle().sourceHealth, comparableBaseline: true },
      episodes: Array.from({ length: 10 }, (_, index) => episode(`inv-${index}`, 'accepted')),
      vector: {
        eligibleEpisodes: 10,
        accepted: 10,
        unresolved: 0,
        notTaken: 0,
        wrongRef: 0,
        timeToFirstAcceptedEvidenceMs: Array(10).fill(400),
        rawOrJsonlFallbackCount: 0,
      },
      validity: { status: 'usable', reasons: [], canonicalCoverage: 1, reviewerDisagreementRate: 0 },
    });
    for (const [name, invalid] of [
      ['calibration', bundle()],
      ['wrong ref', { ...usable, stopUtilityConclusion: true, vector: { ...usable.vector, wrongRef: 1 } }],
      [
        'review missing',
        {
          ...usable,
          episodes: usable.episodes.map((row) => ({ ...row, reviewerAgreement: 'unreviewed' })),
        },
      ],
    ]) {
      assert.throws(
        () =>
          generateTrajectoryInspectorLiveVerdict({
            verdictId: `f299-trajectory-${name.replace(' ', '-')}`,
            harnessFeedbackRoot: mkdtempSync(join(tmpdir(), 'f299-trajectory-action-')),
            domain,
            episodeBundle: invalid,
            submittedPacket: { ...packet('fix'), id: `f299-trajectory-${name.replace(' ', '-')}` },
          }),
        /trajectory_inspector_action_not_allowed/,
        name,
      );
    }

    assert.doesNotThrow(() =>
      generateTrajectoryInspectorLiveVerdict({
        verdictId: 'f299-trajectory-fix-usable',
        harnessFeedbackRoot: mkdtempSync(join(tmpdir(), 'f299-trajectory-action-')),
        domain,
        episodeBundle: usable,
        submittedPacket: { ...packet('fix'), id: 'f299-trajectory-fix-usable' },
      }),
    );
  });

  it('rejects wrong domain, feature, and owner bindings', () => {
    for (const submittedPacket of [
      { ...packet(), domainId: 'eval:a2a' },
      { ...packet(), harnessUnderEval: { ...packet().harnessUnderEval, featureId: 'F192' } },
      { ...packet(), ownerAsk: { ...packet().ownerAsk, targetOwnerCatId: 'codex-sol' } },
    ]) {
      assert.throws(
        () =>
          generateTrajectoryInspectorLiveVerdict({
            verdictId: 'f299-trajectory-binding',
            harnessFeedbackRoot: mkdtempSync(join(tmpdir(), 'f299-trajectory-binding-')),
            domain,
            episodeBundle: bundle(),
            submittedPacket,
          }),
        /trajectory_inspector_generator_wrong_domain|submitted_packet_evidence_mismatch/,
      );
    }
  });
});
