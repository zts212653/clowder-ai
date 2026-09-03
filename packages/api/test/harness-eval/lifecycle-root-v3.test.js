import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCompatibleFrictionLifecycleRootReplay,
  buildLifecycleRootArtifact,
  deriveEvalCaseId,
  digestLifecycleRootArtifact,
  LifecycleRootArtifactSchema,
} from '../../dist/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.js';
import { parseVerdictHandoffPacket } from '../../dist/infrastructure/harness-eval/verdict-handoff.js';

function packet(overrides = {}) {
  return {
    id: 'f313-parent--finding-reader-a1b2c3d4',
    domainId: 'eval:friction',
    findingKey: 'evidence-reader-drilldown-path',
    createdAt: '2026-08-29T03:09:18.499Z',
    phenomenon: 'Repo-relative drill refs fail from package cwd.',
    harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction rollup' },
    evidencePacket: {
      snapshotRefs: ['snapshot:bundle/f313-parent--finding-reader-a1b2c3d4/snapshot'],
      attributionRefs: ['attribution:bundle/f313-parent--finding-reader-a1b2c3d4/F313-reader'],
      metricRefs: ['friction.cluster_count'],
      sampleTraceRefs: ['source-message:1'],
    },
    dailyTrend: {
      window: '3d',
      current: { count: 2 },
      baseline: { count: 0 },
      threshold: { count: 1 },
      direction: 'regressed',
    },
    rootCauseHypothesis: { summary: 'cwd mismatch', confidence: 'medium', alternatives: ['bad ref'] },
    verdict: 'fix',
    ownerAsk: {
      targetFeatureId: 'F188',
      targetOwnerCatId: 'codex-sol',
      requestedAction: 'Resolve drill refs from repository root.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-09-05T03:09:18.499Z',
      closureCondition: 'The same ref opens from repo and package cwd.',
    },
    counterarguments: ['The source ref may itself be malformed.'],
    findingBinding: {
      artifactRef: 'docs/harness-feedback/bundles/f313-parent--finding-reader-a1b2c3d4/finding.json',
      artifactSha256: 'a'.repeat(64),
      analysisDisposition: 'repair',
      approvalRequirement: { kind: 'required', reason: 'repair' },
    },
    repairTarget: {
      featureId: 'F188',
      componentId: 'evidence-reader',
      ownerCatId: 'codex-sol',
      version: `repair-target-v1-${'b'.repeat(64)}`,
      resolutionRef: 'feature-thread-owner:v1:F188:thread_f188:codex-sol',
      resolvedAt: '2026-08-29T03:09:18.499Z',
    },
    ...overrides,
  };
}

describe('schema-v3 friction lifecycle root', () => {
  it('separates F245 harness truth from the resolved repair target and keeps case identity target-free', () => {
    const root = buildLifecycleRootArtifact(parseVerdictHandoffPacket(packet()));
    assert.equal(root.schemaVersion, 3);
    assert.equal(root.harnessUnderEval.featureId, 'F245');
    assert.equal(root.repairTarget.featureId, 'F188');
    assert.equal(root.ownerAsk.targetOwnerCatId, root.repairTarget.ownerCatId);
    assert.equal(root.caseId, deriveEvalCaseId('eval:friction', 'evidence-reader-drilldown-path'));
    assert.match(digestLifecycleRootArtifact(root), /^[a-f0-9]{64}$/);
  });

  it('rejects ownerAsk/repairTarget mismatch', () => {
    assert.throws(
      () =>
        buildLifecycleRootArtifact(
          parseVerdictHandoffPacket(packet({ ownerAsk: { ...packet().ownerAsk, targetOwnerCatId: 'opus-47' } })),
        ),
      /repairTarget/,
    );
  });

  it('fails closed when the same target-resolution version replays with drift', () => {
    const original = buildLifecycleRootArtifact(parseVerdictHandoffPacket(packet()));
    const replay = LifecycleRootArtifactSchema.parse(JSON.parse(JSON.stringify(original)));
    assert.doesNotThrow(() => assertCompatibleFrictionLifecycleRootReplay(original, replay));
    const drifted = LifecycleRootArtifactSchema.parse({
      ...replay,
      ownerAsk: { ...replay.ownerAsk, requestedAction: 'Different action under the same version.' },
    });
    assert.throws(() => assertCompatibleFrictionLifecycleRootReplay(original, drifted), /same-version drift/);
    assert.doesNotThrow(() =>
      assertCompatibleFrictionLifecycleRootReplay(original, {
        ...drifted,
        verdictId: 'f313-parent--finding-reader-next-cycle',
        createdAt: '2026-09-05T03:09:18.499Z',
      }),
    );
  });

  it('preserves v1 and v2 construction/replay unchanged', () => {
    const base = packet();
    delete base.findingBinding;
    delete base.repairTarget;
    const v2 = buildLifecycleRootArtifact(parseVerdictHandoffPacket(base));
    assert.equal(v2.schemaVersion, 2);
    delete base.findingKey;
    const v1 = buildLifecycleRootArtifact(parseVerdictHandoffPacket(base));
    assert.equal(v1.schemaVersion, 1);
    assert.equal(LifecycleRootArtifactSchema.parse(JSON.parse(JSON.stringify(v1))).schemaVersion, 1);
    assert.equal(LifecycleRootArtifactSchema.parse(JSON.parse(JSON.stringify(v2))).schemaVersion, 2);
  });
});
