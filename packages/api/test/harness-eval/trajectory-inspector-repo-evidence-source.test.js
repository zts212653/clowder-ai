import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  GitTrajectoryInspectorArtifactTruth,
  RepoTrajectoryInspectorEvidenceSource,
} from '../../dist/infrastructure/harness-eval/trajectory-inspector/trajectory-inspector-repo-evidence-source.js';

const run = promisify(execFile);
const committedArtifactTruth = { listCommitted: async (paths) => new Set(paths) };

function source(root, artifactTruth = committedArtifactTruth) {
  return new RepoTrajectoryInspectorEvidenceSource({ harnessFeedbackRoot: root, artifactTruth });
}

async function fixture(artifacts) {
  const root = await mkdtemp(join(tmpdir(), 'trajectory-inspector-evidence-'));
  const bundle = join(root, 'bundles', 'verdict-1');
  await mkdir(bundle, { recursive: true });
  for (const [name, value] of Object.entries(artifacts)) {
    await writeFile(join(bundle, name), JSON.stringify(value), 'utf8');
  }
  return root;
}

const selector = { kind: 'trajectory-inspector-window', windowStartMs: 1_000, windowEndMs: 2_000 };

describe('trajectory inspector committed F192 evidence source', () => {
  it('reads only explicit typed finding and accepted-evidence records from existing bundles', async () => {
    const root = await fixture({
      'snapshot.json': {
        phenomenon: 'prose mentioning inv:ignored is not a finding',
        trajectoryInspectorEvidence: [
          {
            kind: 'f192-invocation-finding',
            invocationId: 'inv-finding',
            foundAtMs: 1_200,
            threadId: 'thread-owner',
            sourceRefs: ['snapshot:verdict-1'],
          },
          {
            kind: 'f192-invocation-finding',
            invocationId: 'inv-outside',
            foundAtMs: 999,
            sourceRefs: ['snapshot:verdict-1'],
          },
        ],
      },
      'attribution.json': {
        trajectoryInspectorEvidence: [
          {
            kind: 'f299-accepted-evidence',
            invocationId: 'inv-finding',
            acceptedAtMs: 1_500,
            reviewerAgreement: 'agreed',
            sourceRefs: ['attribution:verdict-1'],
          },
        ],
      },
    });
    const evidenceSource = source(root);

    assert.deepEqual(await evidenceSource.listFindings(selector), [
      {
        invocationId: 'inv-finding',
        foundAtMs: 1_200,
        threadId: 'thread-owner',
        sourceRefs: ['snapshot:verdict-1'],
      },
    ]);
    assert.deepEqual(await evidenceSource.listAcceptedEvidence(selector), [
      {
        invocationId: 'inv-finding',
        acceptedAtMs: 1_500,
        reviewerAgreement: 'agreed',
        sourceRefs: ['attribution:verdict-1'],
      },
    ]);
  });

  it('fails closed when an explicit evidence record is malformed', async () => {
    const root = await fixture({
      'snapshot.json': {
        trajectoryInspectorEvidence: [
          {
            kind: 'f192-invocation-finding',
            invocationId: 'inv-bad',
            foundAtMs: 1_200,
            sourceRefs: ['new-grammar:not-allowed'],
          },
        ],
      },
    });
    const evidenceSource = source(root);
    await assert.rejects(evidenceSource.listFindings(selector), /unsupported canonical evidence ref/);
  });

  it('admits only a prior non-overlapping, healthy, cohort-compatible window as baseline', async () => {
    const root = await fixture({
      'snapshot.json': {
        featureId: 'F299',
        window: { startMs: 100, endMs: 900 },
        validity: { status: 'calibration_only', canonicalCoverage: 1, reviewerDisagreementRate: 0 },
        sourceHealth: { modelRuntimeFingerprints: ['gpt-5.6-sol:codex'] },
        trajectoryInspectorVector: { eligibleEpisodes: 4, wrongRef: 0 },
        trajectoryInspectorCohort: { anomalyKinds: ['error'] },
      },
    });
    const evidenceSource = source(root);

    assert.equal(
      await evidenceSource.hasComparableBaseline(selector, {
        anomalyKinds: ['error'],
        modelRuntimeFingerprints: ['gpt-5.6-sol:codex'],
      }),
      true,
    );
    assert.equal(
      await evidenceSource.hasComparableBaseline(selector, {
        anomalyKinds: ['timeout'],
        modelRuntimeFingerprints: ['gpt-5.6-sol:codex'],
      }),
      false,
    );
  });

  it('does not admit an uncommitted local snapshot as a comparable baseline', async () => {
    const root = await fixture({
      'snapshot.json': {
        featureId: 'F299',
        window: { startMs: 100, endMs: 900 },
        validity: { status: 'usable', canonicalCoverage: 1, reviewerDisagreementRate: 0 },
        sourceHealth: { modelRuntimeFingerprints: ['gpt-5.6-sol:codex'] },
        trajectoryInspectorVector: { eligibleEpisodes: 4, wrongRef: 0 },
        trajectoryInspectorCohort: { anomalyKinds: ['error'] },
        trajectoryInspectorEvidence: [
          {
            kind: 'f192-invocation-finding',
            invocationId: 'inv-uncommitted',
            foundAtMs: 1_200,
            sourceRefs: ['snapshot:verdict-1'],
          },
        ],
      },
    });
    const evidenceSource = source(root, { listCommitted: async () => new Set() });

    assert.equal(
      await evidenceSource.hasComparableBaseline(selector, {
        anomalyKinds: ['error'],
        modelRuntimeFingerprints: ['gpt-5.6-sol:codex'],
      }),
      false,
    );
    assert.deepEqual(await evidenceSource.listFindings(selector), []);
  });

  it('resolves committed artifact truth from the repository index', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'trajectory-inspector-git-truth-'));
    const tracked = join(repoRoot, 'tracked.json');
    const untracked = join(repoRoot, 'untracked.json');
    await run('git', ['init'], { cwd: repoRoot });
    await run('git', ['config', 'user.email', 'trajectory-inspector@example.invalid'], { cwd: repoRoot });
    await run('git', ['config', 'user.name', 'Trajectory Inspector Test'], { cwd: repoRoot });
    await writeFile(tracked, '{}', 'utf8');
    await writeFile(untracked, '{}', 'utf8');
    await run('git', ['add', 'tracked.json'], { cwd: repoRoot });
    await run('git', ['commit', '-m', 'test: add tracked artifact'], { cwd: repoRoot });
    const truth = new GitTrajectoryInspectorArtifactTruth(repoRoot);

    assert.deepEqual(
      await truth.listCommitted([tracked, untracked, join(repoRoot, '..', 'outside.json')]),
      new Set([tracked]),
    );
    await writeFile(tracked, '{"dirty":true}', 'utf8');
    assert.deepEqual(await truth.listCommitted([tracked]), new Set());
  });
});
