import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reduceTrajectoryInspectorEpisodes } from '../../dist/infrastructure/harness-eval/trajectory-inspector/trajectory-inspector-reducer.js';

function episode(index, overrides = {}) {
  const invocationId = `inv-${index}`;
  return {
    episodeId: `trajectory:${invocationId}`,
    invocationId,
    threadId: 'thread-owner',
    sessionId: 'session-owner',
    eligibleAtMs: 1_000 + index,
    eligibility: ['terminal_anomaly'],
    anomalyKind: 'error',
    model: 'gpt-5.6-sol',
    runtime: 'codex',
    firstAcceptedEvidenceAtMs: null,
    evidenceOutcome: 'not_taken',
    rawOrJsonlFallback: false,
    reviewerAgreement: 'unreviewed',
    sourceRefs: [`inv:${invocationId}`, 'thread:thread-owner', 'session:session-owner'],
    ...overrides,
  };
}

const healthySource = {
  canonicalResolvedEpisodes: 10,
  canonicalCandidateEpisodes: 10,
  significantModelRuntimeDrift: false,
  comparableBaseline: true,
};

describe('trajectory inspector deterministic reducer', () => {
  it('preserves every eligible opportunity across the three-dimensional birth-certificate vector', () => {
    const episodes = [
      episode(3, { evidenceOutcome: 'wrong_ref' }),
      episode(1, { evidenceOutcome: 'accepted', firstAcceptedEvidenceAtMs: 1_061 }),
      episode(4, { evidenceOutcome: 'not_taken', rawOrJsonlFallback: true }),
      episode(2, { evidenceOutcome: 'unresolved' }),
    ];

    const result = reduceTrajectoryInspectorEpisodes({
      episodes,
      sourceHealth: {
        ...healthySource,
        canonicalResolvedEpisodes: 4,
        canonicalCandidateEpisodes: 4,
      },
    });

    assert.deepEqual(
      result.episodes.map((row) => row.episodeId),
      ['trajectory:inv-1', 'trajectory:inv-2', 'trajectory:inv-3', 'trajectory:inv-4'],
    );
    assert.deepEqual(result.vector, {
      eligibleEpisodes: 4,
      accepted: 1,
      unresolved: 1,
      notTaken: 1,
      wrongRef: 1,
      timeToFirstAcceptedEvidenceMs: [60],
      rawOrJsonlFallbackCount: 1,
    });
    assert.equal(
      result.vector.accepted + result.vector.unresolved + result.vector.notTaken + result.vector.wrongRef,
      result.vector.eligibleEpisodes,
    );
    assert.equal(result.stopUtilityConclusion, true);
    assert.equal(result.validity.status, 'invalid');
    assert.equal('totalScore' in result, false);
    assert.equal('openRate' in result.vector, false);
  });

  it('enforces every validity bound without turning missing external bits into success', () => {
    const accepted = Array.from({ length: 8 }, (_, index) =>
      episode(index + 1, {
        evidenceOutcome: 'accepted',
        firstAcceptedEvidenceAtMs: 2_000 + index,
        reviewerAgreement: index < 3 ? 'disagreed' : 'agreed',
      }),
    );
    const silent = [episode(9), episode(10, { evidenceOutcome: 'unresolved' })];
    const result = reduceTrajectoryInspectorEpisodes({
      episodes: [...accepted, ...silent],
      sourceHealth: {
        ...healthySource,
        canonicalResolvedEpisodes: 9,
        significantModelRuntimeDrift: true,
        comparableBaseline: false,
      },
    });

    assert.equal(result.validity.status, 'calibration_only');
    assert.equal(result.validity.canonicalCoverage, 0.9);
    assert.equal(result.validity.reviewerDisagreementRate, 0.375);
    assert.deepEqual(result.validity.reasons, [
      'canonical_coverage_degraded',
      'significant_model_runtime_drift',
      'reviewer_disagreement_above_20_percent',
      'comparable_baseline_unavailable',
    ]);
    assert.equal(result.vector.notTaken, 1);
    assert.equal(result.vector.unresolved, 1);
  });

  it('keeps the first sub-10 window calibration-only and becomes usable only with all bounds satisfied', () => {
    const calibration = reduceTrajectoryInspectorEpisodes({
      episodes: Array.from({ length: 9 }, (_, index) => episode(index + 1)),
      sourceHealth: {
        ...healthySource,
        canonicalResolvedEpisodes: 9,
        canonicalCandidateEpisodes: 9,
      },
    });
    assert.equal(calibration.validity.status, 'calibration_only');
    assert.deepEqual(calibration.validity.reasons, ['fewer_than_10_eligible_episodes', 'external_review_unavailable']);

    const usable = reduceTrajectoryInspectorEpisodes({
      episodes: Array.from({ length: 10 }, (_, index) =>
        episode(index + 1, {
          evidenceOutcome: 'accepted',
          firstAcceptedEvidenceAtMs: 2_000 + index,
          reviewerAgreement: 'agreed',
        }),
      ),
      sourceHealth: healthySource,
    });
    assert.equal(usable.validity.status, 'usable');
    assert.deepEqual(usable.validity.reasons, []);
    assert.equal(usable.stopUtilityConclusion, false);
  });

  it('is bit-stable under input order and rejects duplicate or impossible evidence identities', () => {
    const input = {
      episodes: [
        episode(2, { evidenceOutcome: 'accepted', firstAcceptedEvidenceAtMs: 1_022, reviewerAgreement: 'agreed' }),
        episode(1, { evidenceOutcome: 'unresolved', reviewerAgreement: 'agreed' }),
      ],
      sourceHealth: {
        ...healthySource,
        canonicalResolvedEpisodes: 2,
        canonicalCandidateEpisodes: 2,
      },
    };
    assert.deepEqual(
      reduceTrajectoryInspectorEpisodes(input),
      reduceTrajectoryInspectorEpisodes({ ...input, episodes: [...input.episodes].reverse() }),
    );
    assert.throws(
      () => reduceTrajectoryInspectorEpisodes({ ...input, episodes: [episode(1), episode(1)] }),
      /duplicate episodeId/,
    );
    assert.throws(
      () =>
        reduceTrajectoryInspectorEpisodes({
          ...input,
          episodes: [episode(1, { evidenceOutcome: 'accepted', firstAcceptedEvidenceAtMs: 999 })],
        }),
      /accepted evidence must not precede eligibility/,
    );
  });
});
