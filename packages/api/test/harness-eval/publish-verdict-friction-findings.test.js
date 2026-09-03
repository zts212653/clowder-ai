import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildFrictionRollupReport } from '../../dist/infrastructure/harness-eval/friction/friction-rollup-report.js';
import { createFrictionGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/friction-generator-adapter.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket, seedCanonicalMeasurementCensusState } from './publish-verdict-fixtures.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/harness-eval/f313/three-candidate-friction-capture.json', import.meta.url), 'utf8'),
);

const FRICTION_YAML = `domainId: eval:friction
displayName: Friction Signal Eval
systemThreadId: thread_eval_friction
evalCat: { catId: gpt52, handle: '@gpt52', model: gpt-5.4 }
frequency: weekly
sourceAdapter: f245-friction-rollup
sourceRefsKind: friction-rollup-snapshot
threadPolicy: { role: working-home, stateSot: registry, allowedContent: [longitudinal-analysis, verdict-discussion] }
legacyScheduledTaskIds: []
handoffTargetResolver: { featureId: F245, ownerCatId: opus-47, threadLookup: feature-thread }
sla: { acknowledgeHours: 48, reevalWithinHours: 168 }
fixtures: []
enabled: true
`;

let root;
before(() => {
  root = setupHarnessFeedback();
  writeFileSync(join(root, 'eval-domains', 'eval-friction.yaml'), FRICTION_YAML);
});
after(() => rmSync(root, { recursive: true, force: true }));

function measurementCapture() {
  const emittedIds = fixture.rollupInput.signals.map((signal) => signal.id);
  return {
    capturedAt: fixture.capturedAt,
    expectedCancelIds: [],
    channelCaptures: {
      'paw-feel': { status: 'ok', emittedIds },
      cancel: { status: 'ok', emittedIds: [] },
      'user-feedback': { status: 'ok', emittedIds: [] },
      'eval-domain': { status: 'ok', emittedIds: [] },
    },
    rollupInput: fixture.rollupInput,
    rollupReport: buildFrictionRollupReport(fixture.rollupInput, fixture.capturedAt),
  };
}

function packet(id = 'f313-three-candidate-fixture') {
  return buildPacket({
    id,
    domainId: 'eval:friction',
    createdAt: fixture.capturedAt,
    verdict: 'keep_observe',
    harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction rollup' },
    ownerAsk: { targetFeatureId: 'F245', targetOwnerCatId: 'opus-47', requestedAction: 'Observe aggregate window.' },
    evidencePacket: {
      snapshotRefs: ['placeholder:snapshot'],
      attributionRefs: ['placeholder:attribution'],
      metricRefs: ['friction.cluster_count'],
      sampleTraceRefs: ['source-message:f313'],
    },
  });
}

function judgment(candidateRef, findingKey, featureId, overrides = {}) {
  const sourceSignalRefs = fixture.rollupInput.clusters
    .find((cluster) => cluster.clusterId === candidateRef)
    .members.map((member) => `source-message:${member.rawRef}`);
  return {
    candidateRef,
    findingKey,
    analysisDisposition: 'observe',
    approvalRequirement: { kind: 'not_required' },
    rationale: `Typed analysis for ${candidateRef}.`,
    uncertainty: 'medium',
    falsifier: {
      condition: `Candidate ${candidateRef} disappears in a fresh window.`,
      evidenceRef: `falsifier:${candidateRef}`,
    },
    withdrawalCondition: `Withdraw when ${candidateRef} no longer reproduces.`,
    measurementResultRef: `measurement:f267/${candidateRef}`,
    sourceSignalRefs,
    repairTargetHint: { featureId },
    ...overrides,
  };
}

function findings() {
  return [
    judgment('9028c961c203', 'evidence-reader-drilldown-path', 'F188', {
      analysisDisposition: 'repair',
      approvalRequirement: { kind: 'required', reason: 'repair' },
      interventionKind: 'fix',
    }),
    judgment('04eaba997290', 'default-mode-tool-availability', 'F203'),
    judgment('1193e4fa241b', 'a2a-disposition-source-mismatch', 'F167', {
      analysisDisposition: 'insufficient',
      uncertainty: 'high',
    }),
  ];
}

const owners = { F188: 'codex-sol', F203: 'opus-47', F167: 'codex-terra' };
const targetResolver = {
  async resolve({ hint, resolvedAt }) {
    const ownerCatId = owners[hint.featureId];
    if (!ownerCatId)
      return {
        status: 'blocked',
        reason: 'owner_unresolved',
        evidenceRef: `feature-index:${hint.featureId}:not-found`,
      };
    const resolutionRef = `feature-thread-owner:v1:${hint.featureId}:thread_${hint.featureId.toLowerCase()}:${ownerCatId}`;
    const digest = createHash('sha256')
      .update(`${hint.featureId}\u001f\u001f${ownerCatId}\u001f${resolutionRef}`)
      .digest('hex');
    return {
      status: 'resolved',
      target: {
        featureId: hint.featureId,
        ownerCatId,
        version: `repair-target-v1-${digest}`,
        resolutionRef,
        resolvedAt,
      },
    };
  },
};

function isolatedPublisher(label, captures) {
  return {
    async publishOnIsolatedWorktree(opts) {
      const iso = join(root, '..', `f313-friction-${label}`);
      rmSync(iso, { recursive: true, force: true });
      mkdirSync(join(iso, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
      writeFileSync(join(iso, 'docs', 'harness-feedback', 'eval-domains', 'eval-friction.yaml'), FRICTION_YAML);
      seedCanonicalMeasurementCensusState(iso);
      captures.push({ iso, stage: await opts.stage(iso) });
      return { commitSha: `${label}-sha`, prUrl: `https://example.test/${label}` };
    },
  };
}

async function publish(label, analysisFindings = findings(), resolver = targetResolver) {
  const captures = [];
  const generator = createFrictionGeneratorAdapter({ resolve: async () => measurementCapture() }, resolver);
  const result = await handlePublishVerdict(
    {
      harnessFeedbackRoot: root,
      gitPublisher: isolatedPublisher(label, captures),
      generator,
      now: () => new Date(fixture.capturedAt),
    },
    {
      packet: packet(),
      domain: 'eval:friction',
      catId: 'gpt52',
      ownerUserId: 'user-1',
      sourceRefs: fixture.selector,
      analysisFindings,
    },
  );
  return { result, captures };
}

describe('eval:friction finding breakout publish', () => {
  it('preserves the aggregate verdict and writes three deterministic child packets, bundles, findings, and v3 roots', async () => {
    const { result, captures } = await publish('first');
    assert.ok(!('error' in result), JSON.stringify(result));
    assert.equal(result.childArtifacts.length, 3);
    assert.equal(new Set(result.childArtifacts.map((child) => child.verdictId)).size, 3);
    assert.deepEqual(
      result.childArtifacts.map(({ verdictId, findingKey, findingArtifactSha256, lifecycleRootSha256 }) => ({
        verdictId,
        findingKey,
        findingArtifactSha256,
        lifecycleRootSha256,
      })),
      fixture.expectedChildDigests,
    );
    const [{ iso }] = captures;
    const aggregateRoot = JSON.parse(
      readFileSync(join(iso, 'docs', 'harness-feedback', 'bundles', packet().id, 'lifecycle-root.json'), 'utf8'),
    );
    assert.equal(aggregateRoot.schemaVersion, 1);
    assert.equal(aggregateRoot.verdict, 'keep_observe');

    for (const child of result.childArtifacts) {
      assert.match(child.findingArtifactSha256, /^[a-f0-9]{64}$/);
      assert.match(child.lifecycleRootSha256, /^[a-f0-9]{64}$/);
      const bundle = join(iso, child.bundleDir);
      assert.ok(existsSync(join(bundle, 'finding.json')));
      assert.ok(existsSync(join(bundle, 'snapshot.json')));
      assert.ok(existsSync(join(bundle, 'attribution.json')));
      const rootArtifact = JSON.parse(readFileSync(join(bundle, 'lifecycle-root.json'), 'utf8'));
      assert.equal(rootArtifact.schemaVersion, 3);
      assert.equal(rootArtifact.harnessUnderEval.featureId, 'F245');
      assert.notEqual(rootArtifact.repairTarget.featureId, 'F245');
      assert.equal(rootArtifact.ownerAsk.targetFeatureId, rootArtifact.repairTarget.featureId);
      assert.equal(rootArtifact.ownerAsk.targetOwnerCatId, rootArtifact.repairTarget.ownerCatId);
    }
  });

  it('replays to the same three child refs and finding/root digests', async () => {
    const first = await publish('replay-a');
    const replay = await publish('replay-b');
    assert.ok(!('error' in first.result) && !('error' in replay.result));
    assert.deepEqual(first.result.childArtifacts, replay.result.childArtifacts);
  });

  it('writes only a finding artifact when canonical target resolution is blocked', async () => {
    const blockedResolver = {
      async resolve(input) {
        if (input.hint.featureId === 'F203') {
          return { status: 'blocked', reason: 'owner_unresolved', evidenceRef: 'feature-index:F203:owner-unresolved' };
        }
        return targetResolver.resolve(input);
      },
    };
    const { result, captures } = await publish('blocked-target', findings(), blockedResolver);
    assert.ok(!('error' in result), JSON.stringify(result));
    assert.equal(result.findingArtifacts.length, 3);
    assert.equal(result.childArtifacts.length, 2);
    const blockedFinding = result.findingArtifacts.find(
      (finding) => finding.findingKey === 'default-mode-tool-availability',
    );
    assert.deepEqual(
      { status: blockedFinding?.resolutionStatus, reason: blockedFinding?.blockerReason },
      { status: 'blocked', reason: 'owner_unresolved' },
    );

    const [{ iso }] = captures;
    assert.ok(
      existsSync(
        join(
          iso,
          'docs',
          'harness-feedback',
          'bundles',
          packet().id,
          'findings',
          'default-mode-tool-availability',
          'finding.json',
        ),
      ),
    );
    assert.equal(
      result.childArtifacts.some((child) => child.findingKey === 'default-mode-tool-availability'),
      false,
    );
  });

  it('rejects an actionable aggregate before stage so only child roots can carry authority', async () => {
    let stageCalls = 0;
    const generator = createFrictionGeneratorAdapter({ resolve: async () => measurementCapture() }, targetResolver);
    const actionableAggregate = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        generator,
        gitPublisher: {
          async publishOnIsolatedWorktree() {
            stageCalls += 1;
          },
        },
      },
      {
        packet: { ...packet('f313-actionable-aggregate'), verdict: 'fix' },
        domain: 'eval:friction',
        catId: 'gpt52',
        ownerUserId: 'user-1',
        sourceRefs: fixture.selector,
        analysisFindings: findings(),
      },
    );
    assert.equal(actionableAggregate.error, 'invalid_analysis_findings');
    assert.equal(stageCalls, 0);
  });

  it('rejects duplicate, missing, unknown, unstable-key, and invalid-disposition mappings without a partial publish', async () => {
    let stageCalls = 0;
    const duplicate = findings();
    duplicate[1] = { ...duplicate[1], findingKey: duplicate[0].findingKey };
    const generator = createFrictionGeneratorAdapter({ resolve: async () => measurementCapture() }, targetResolver);
    const duplicateResult = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        generator,
        gitPublisher: {
          async publishOnIsolatedWorktree() {
            stageCalls += 1;
          },
        },
      },
      {
        packet: packet('f313-duplicate'),
        domain: 'eval:friction',
        catId: 'gpt52',
        ownerUserId: 'user-1',
        sourceRefs: fixture.selector,
        analysisFindings: duplicate,
      },
    );
    assert.equal(duplicateResult.error, 'invalid_analysis_findings');
    assert.equal(stageCalls, 0);

    for (const invalidFinding of [
      { ...findings()[0], findingKey: 'Unstable Key' },
      { ...findings()[0], analysisDisposition: 'guess' },
    ]) {
      const invalid = findings();
      invalid[0] = invalidFinding;
      const invalidResult = await handlePublishVerdict(
        {
          harnessFeedbackRoot: root,
          generator,
          gitPublisher: {
            async publishOnIsolatedWorktree() {
              stageCalls += 1;
            },
          },
        },
        {
          packet: packet(`f313-invalid-${invalidFinding.analysisDisposition}`),
          domain: 'eval:friction',
          catId: 'gpt52',
          ownerUserId: 'user-1',
          sourceRefs: fixture.selector,
          analysisFindings: invalid,
        },
      );
      assert.equal(invalidResult.error, 'invalid_analysis_findings');
      assert.equal(stageCalls, 0);
    }

    const missing = await publish('missing', findings().slice(0, 2));
    assert.equal(missing.result.error, 'invalid_analysis_findings');
    const unknown = findings();
    unknown[2] = { ...unknown[2], candidateRef: 'unknown-candidate' };
    const unknownResult = await publish('unknown', unknown);
    assert.equal(unknownResult.result.error, 'invalid_analysis_findings');
  });
});
