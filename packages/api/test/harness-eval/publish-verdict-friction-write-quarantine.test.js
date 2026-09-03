import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { generateFrictionFindingChildren } from '../../dist/infrastructure/harness-eval/friction/friction-finding-child-artifact.js';
import { buildFrictionRollupReport } from '../../dist/infrastructure/harness-eval/friction/friction-rollup-report.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { buildPacket } from './publish-verdict-fixtures.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/harness-eval/f313/three-candidate-friction-capture.json', import.meta.url), 'utf8'),
);
const tempRoots = new Set();

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function aggregatePacket(overrides = {}) {
  return buildPacket({
    id: 'f313-friction-write-quarantine',
    domainId: 'eval:friction',
    createdAt: fixture.capturedAt,
    verdict: 'keep_observe',
    harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction rollup' },
    ownerAsk: { targetFeatureId: 'F245', targetOwnerCatId: 'opus-47', requestedAction: 'Observe aggregate.' },
    evidencePacket: {
      snapshotRefs: ['placeholder:snapshot'],
      attributionRefs: ['placeholder:attribution'],
      metricRefs: ['friction.cluster_count'],
      sampleTraceRefs: ['source-message:f313'],
    },
    ...overrides,
  });
}

function analysisFindings(report) {
  return report.actionableCandidates.map((candidate, index) => ({
    candidateRef: candidate.clusterId,
    findingKey: `capture-anchor-${index + 1}`,
    analysisDisposition: 'observe',
    approvalRequirement: { kind: 'not_required' },
    rationale: `Observe ${candidate.clusterId}.`,
    uncertainty: 'medium',
    falsifier: {
      condition: `Candidate ${candidate.clusterId} disappears in a fresh window.`,
      evidenceRef: `falsifier:${candidate.clusterId}`,
    },
    withdrawalCondition: `Withdraw when ${candidate.clusterId} no longer reproduces.`,
    measurementResultRef: `measurement:f313/${candidate.clusterId}`,
    sourceSignalRefs: [`source-message:${candidate.clusterId}`],
    repairTargetHint: { featureId: 'F313' },
  }));
}

async function generateChildren(createdAt, resolvedAtInputs) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'f313-friction-write-quarantine-'));
  tempRoots.add(repoRoot);
  const harnessFeedbackRoot = join(repoRoot, 'docs', 'harness-feedback');
  mkdirSync(join(harnessFeedbackRoot, 'verdicts'), { recursive: true });
  const report = buildFrictionRollupReport(fixture.rollupInput, fixture.capturedAt);
  const output = await generateFrictionFindingChildren({
    parentPacket: aggregatePacket({ createdAt }),
    parentBundleDir: join(harnessFeedbackRoot, 'bundles', 'f313-friction-write-quarantine'),
    harnessFeedbackRoot,
    report,
    selector: fixture.selector,
    analysisFindings: analysisFindings(report),
    targetResolver: {
      async resolve({ resolvedAt }) {
        resolvedAtInputs.push(resolvedAt);
        return {
          status: 'resolved',
          target: {
            featureId: 'F313',
            ownerCatId: 'codex-sol',
            version: `repair-target-v1-${'a'.repeat(64)}`,
            resolutionRef: 'feature-thread-owner:v1:F313:thread_f313:codex-sol',
            resolvedAt,
          },
        };
      },
    },
    ownerUserId: 'user-1',
  });
  return { output, repoRoot };
}

describe('eval:friction new-write quarantine', () => {
  it('rejects caller-owned v2 case identity and actionable aggregate authority before staging', async () => {
    let stageCalls = 0;
    for (const packet of [
      aggregatePacket({ id: 'f313-caller-finding-key', findingKey: 'caller-controlled-case' }),
      aggregatePacket({ id: 'f313-actionable-without-findings', verdict: 'fix' }),
    ]) {
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot: '/unused',
          gitPublisher: {
            async publishOnIsolatedWorktree() {
              stageCalls += 1;
            },
          },
        },
        {
          packet,
          domain: 'eval:friction',
          catId: 'gpt52',
          ownerUserId: 'user-1',
          sourceRefs: fixture.selector,
        },
      );
      assert.deepEqual(
        { status: result.status, error: result.error },
        { status: 400, error: 'invalid_friction_aggregate' },
      );
    }
    assert.equal(stageCalls, 0);
  });

  it('anchors resolvedAt and finding digests to the trusted capture instead of packet.createdAt', async () => {
    const resolvedAtInputs = [];
    const control = await generateChildren(fixture.capturedAt, resolvedAtInputs);
    const spoofed = await generateChildren('2042-12-31T23:59:59.999Z', resolvedAtInputs);

    assert.deepEqual(
      spoofed.output.findingArtifacts.map((finding) => finding.artifactSha256),
      control.output.findingArtifacts.map((finding) => finding.artifactSha256),
    );
    assert.ok(resolvedAtInputs.length > 0);
    assert.deepEqual(new Set(resolvedAtInputs), new Set([fixture.capturedAt]));

    for (const findingArtifact of spoofed.output.findingArtifacts) {
      const finding = JSON.parse(readFileSync(join(spoofed.repoRoot, findingArtifact.artifactRef), 'utf8'));
      assert.equal(finding.repairTargetResolution.target.resolvedAt, fixture.capturedAt);
    }
  });
});
