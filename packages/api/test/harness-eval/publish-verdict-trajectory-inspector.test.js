import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validateSourceRefsForPublish } from '../../dist/infrastructure/harness-eval/publish-verdict/source-ref-handler-validation.js';
import { createTrajectoryInspectorGeneratorAdapter } from '../../dist/infrastructure/harness-eval/trajectory-inspector/trajectory-inspector-generator-adapter.js';

const repoDomainRoot = new URL('../../../../docs/harness-feedback/eval-domains/', import.meta.url);

function rootWithDomain() {
  const root = mkdtempSync(join(tmpdir(), 'f299-trajectory-adapter-'));
  mkdirSync(join(root, 'eval-domains'), { recursive: true });
  cpSync(
    new URL('eval-trajectory-inspector.yaml', repoDomainRoot),
    join(root, 'eval-domains', 'eval-trajectory-inspector.yaml'),
  );
  cpSync(
    new URL('eval-trajectory-inspector.metrics.yaml', repoDomainRoot),
    join(root, 'eval-domains', 'eval-trajectory-inspector.metrics.yaml'),
  );
  return root;
}

const packet = {
  id: 'f299-adapter-observe',
  domainId: 'eval:trajectory-inspector',
  findingKey: 'utility-window',
  createdAt: '2026-08-24T20:00:00.000Z',
  phenomenon: 'Calibration window.',
  harnessUnderEval: { featureId: 'F299', componentId: 'trajectory-inspector-utility', name: 'Inspector' },
  evidencePacket: {
    snapshotRefs: ['placeholder:snapshot'],
    attributionRefs: ['placeholder:attribution'],
    metricRefs: ['metric:eligible_episodes'],
    sampleTraceRefs: ['snapshot:placeholder'],
  },
  dailyTrend: { window: 'x', current: {}, baseline: {}, threshold: {}, direction: 'unknown' },
  rootCauseHypothesis: { summary: 'Calibration.', confidence: 'low', alternatives: ['No data.'] },
  verdict: 'keep_observe',
  ownerAsk: { targetFeatureId: 'F299', targetOwnerCatId: 'fable5', requestedAction: 'Observe.' },
  acceptanceReevalPlan: {
    nextEvalAt: '2026-08-31T20:00:00.000Z',
    closureCondition: 'Later trusted re-eval.',
  },
  counterarguments: ['Window may be incomplete.'],
};

const emptyBundle = {
  selector: { kind: 'trajectory-inspector-window', windowStartMs: 1_000, windowEndMs: 2_000 },
  sourceHealth: {
    canonicalResolvedEpisodes: 0,
    canonicalCandidateEpisodes: 0,
    missingTranscriptSessions: 0,
    significantModelRuntimeDrift: false,
    modelRuntimeFingerprints: [],
    comparableBaseline: false,
  },
  episodes: [],
  vector: {
    eligibleEpisodes: 0,
    accepted: 0,
    unresolved: 0,
    notTaken: 0,
    wrongRef: 0,
    timeToFirstAcceptedEvidenceMs: [],
    rawOrJsonlFallbackCount: 0,
  },
  validity: {
    status: 'calibration_only',
    reasons: ['fewer_than_10_eligible_episodes'],
    canonicalCoverage: 0,
    reviewerDisagreementRate: null,
  },
  stopUtilityConclusion: false,
};

describe('trajectory inspector publish adapter', () => {
  it('is admitted by the shared publish handler validator', () => {
    assert.equal(
      validateSourceRefsForPublish({
        kind: 'trajectory-inspector-window',
        windowStartMs: 1_000,
        windowEndMs: 2_000,
      }),
      null,
    );
    assert.equal(
      validateSourceRefsForPublish({
        kind: 'trajectory-inspector-window',
        windowStartMs: 2_000,
        windowEndMs: 1_000,
      }).error,
      'invalid_source_ref',
    );
  });

  it('resolves the selector with the server-trusted owner and writes through the shared generator', async () => {
    let observed;
    const adapter = createTrajectoryInspectorGeneratorAdapter({
      resolve: async (selector, context) => {
        observed = { selector, context };
        return emptyBundle;
      },
    });
    const root = rootWithDomain();
    const result = await adapter(
      packet,
      { kind: 'trajectory-inspector-window', windowStartMs: 1_000, windowEndMs: 2_000 },
      { harnessFeedbackRoot: root, liveHarnessFeedbackRoot: root, ownerUserId: 'owner' },
    );
    assert.deepEqual(observed, {
      selector: { kind: 'trajectory-inspector-window', windowStartMs: 1_000, windowEndMs: 2_000 },
      context: { ownerUserId: 'owner' },
    });
    assert.match(result.verdictPath, /f299-adapter-observe\.md$/);
    assert.match(result.bundleDir, /bundles\/f299-adapter-observe$/);
  });

  it('rejects wrong kind, invalid window, and missing trusted owner before source resolution', async () => {
    let calls = 0;
    const adapter = createTrajectoryInspectorGeneratorAdapter({
      resolve: async () => {
        calls += 1;
        return emptyBundle;
      },
    });
    const root = rootWithDomain();
    await assert.rejects(
      adapter(
        packet,
        { kind: 'qc-metrics-rollup', windowStartMs: 1_000, windowEndMs: 2_000 },
        {
          harnessFeedbackRoot: root,
          liveHarnessFeedbackRoot: root,
          ownerUserId: 'owner',
        },
      ),
      /trajectory_inspector_adapter_wrong_kind/,
    );
    await assert.rejects(
      adapter(
        packet,
        { kind: 'trajectory-inspector-window', windowStartMs: 2_000, windowEndMs: 1_000 },
        {
          harnessFeedbackRoot: root,
          liveHarnessFeedbackRoot: root,
          ownerUserId: 'owner',
        },
      ),
      /invalid_source_ref/,
    );
    await assert.rejects(
      adapter(
        packet,
        { kind: 'trajectory-inspector-window', windowStartMs: 1_000, windowEndMs: 2_000 },
        {
          harnessFeedbackRoot: root,
          liveHarnessFeedbackRoot: root,
        },
      ),
      /owner identity unavailable/,
    );
    assert.equal(calls, 0);
  });
});
