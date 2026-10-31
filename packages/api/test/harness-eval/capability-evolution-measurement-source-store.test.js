import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { promisify } from 'node:util';

import { stringify } from 'yaml';

import {
  keepProofInsufficient,
  PROGRAM_ID,
  program,
  SOURCE_REF,
  sha256,
  validSourceManifest,
  writeYaml,
} from './capability-evolution-measurement-fixtures.js';

const exec = promisify(execFile);

async function git(repoRoot, ...args) {
  return (await exec('git', ['-C', repoRoot, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}

it('issues from origin/main when owner inputs precede the manifest and rejects unrelated revisions', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-git-'));
  const remoteRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-remote-'));
  try {
    await exec('git', ['init', '--bare', remoteRoot]);
    await exec('git', ['init', '-b', 'main', repoRoot]);
    await git(repoRoot, 'config', 'user.name', 'F267 Test');
    await git(repoRoot, 'config', 'user.email', 'f267@example.invalid');
    await git(repoRoot, 'remote', 'add', 'origin', remoteRoot);

    const cohortRef = 'docs/content/drafts/f267-capability-evolution-source-cohort.yaml';
    const cohortBytes = Buffer.from('kind: listener-restatement-cohort\nobservations: []\n');
    await mkdir(dirname(join(repoRoot, cohortRef)), { recursive: true });
    await writeFile(join(repoRoot, cohortRef), cohortBytes);
    await git(repoRoot, 'add', '--', cohortRef);
    await git(repoRoot, 'commit', '-m', 'test: commit source-owner input');
    const sourceRevision = await git(repoRoot, 'rev-parse', 'HEAD');

    const manifest = await validSourceManifest();
    keepProofInsufficient(manifest);
    manifest.sourceRevision = sourceRevision;
    manifest.certificate.provenance.sourceRevision = sourceRevision;
    manifest.result.cohort.ref = cohortRef;
    manifest.result.cohort.sha256 = sha256(cohortBytes);
    manifest.sourceArtifacts = [{ ownerFeatureId: 'F311', ref: cohortRef, sha256: manifest.result.cohort.sha256 }];
    manifest.decisionProof.subject.certificateSha256 = sha256(Buffer.from(stringify(manifest.certificate)));
    manifest.decisionProof.subject.resultSha256 = sha256(Buffer.from(stringify(manifest.result)));
    manifest.decisionProof.subject.evaluationCohortRef = cohortRef;
    manifest.decisionProof.subject.evaluationCohortSha256 = manifest.result.cohort.sha256;
    await writeYaml(repoRoot, SOURCE_REF, manifest);
    await git(repoRoot, 'add', '--', SOURCE_REF);
    await git(repoRoot, 'commit', '-m', 'test: commit source-owner manifest');
    const manifestRevision = await git(repoRoot, 'rev-parse', 'HEAD');
    await git(repoRoot, 'push', '-u', 'origin', 'main');

    const { createCapabilityEvolutionMeasurementIssuer } = await import(
      '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-issuer.js'
    );
    const issuer = createCapabilityEvolutionMeasurementIssuer({
      repoRoot,
      programReader: { get: async () => program() },
      gitPublisher: {
        publishOnIsolatedWorktree: async (options) => {
          assert.equal(options.sourceBase, manifestRevision);
          const stageRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-stage-'));
          try {
            await git(repoRoot, 'worktree', 'add', '--detach', stageRoot, options.sourceBase);
            await options.stage(stageRoot);
          } finally {
            await git(repoRoot, 'worktree', 'remove', '--force', stageRoot);
          }
          return { commitSha: 'd'.repeat(40), prUrl: 'https://github.test/cat-cafe/pull/3' };
        },
      },
    });
    const issued = await issuer.issue({
      programId: PROGRAM_ID,
      ownerUserId: 'operator',
      catId: 'codex-sol',
      clientMessageId: 'owner-source-message-real-git',
    });
    assert.equal(issued.status, 'published', JSON.stringify(issued));
    assert.equal(issued.proofStatus, 'insufficient');

    const { createGitCapabilityEvolutionMeasurementSourceStore } = await import(
      '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source-store.js'
    );
    const store = createGitCapabilityEvolutionMeasurementSourceStore({ repoRoot });
    const wrongHash = structuredClone(manifest);
    wrongHash.sourceArtifacts[0].sha256 = '0'.repeat(64);
    assert.deepEqual(await store.verifySourceRevision({ manifest: wrongHash, manifestRevision }), {
      status: 'invalid',
      detail: `source artifact missing or hash-mismatched: ${cohortRef}`,
    });
    assert.deepEqual(
      await store.verifySourceRevision({
        manifest: { ...manifest, sourceRevision: manifestRevision },
        manifestRevision,
      }),
      { status: 'invalid', detail: 'source revision must strictly precede the manifest revision' },
    );

    const symlinkRef = 'docs/content/drafts/f267-capability-evolution-symlink.yaml';
    await symlink('f267-capability-evolution-source-cohort.yaml', join(repoRoot, symlinkRef));
    await git(repoRoot, 'add', '--', symlinkRef);
    await git(repoRoot, 'commit', '-m', 'test: commit source-owner symlink');
    const symlinkRevision = await git(repoRoot, 'rev-parse', 'HEAD');
    const symlinkManifest = structuredClone(manifest);
    symlinkManifest.sourceRevision = symlinkRevision;
    symlinkManifest.sourceArtifacts = [
      {
        ownerFeatureId: 'F311',
        ref: symlinkRef,
        sha256: sha256(Buffer.from('f267-capability-evolution-source-cohort.yaml')),
      },
    ];
    await writeYaml(repoRoot, SOURCE_REF, symlinkManifest);
    await git(repoRoot, 'add', '--', SOURCE_REF);
    await git(repoRoot, 'commit', '-m', 'test: point manifest at source-owner symlink');
    const symlinkManifestRevision = await git(repoRoot, 'rev-parse', 'HEAD');
    assert.deepEqual(
      await store.verifySourceRevision({ manifest: symlinkManifest, manifestRevision: symlinkManifestRevision }),
      {
        status: 'invalid',
        detail: `source path is not a regular repository file: ${symlinkRef}`,
      },
    );

    const unrelatedRevision = await git(
      repoRoot,
      'commit-tree',
      '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      '-m',
      'unrelated source',
    );
    manifest.sourceRevision = unrelatedRevision;
    manifest.certificate.provenance.sourceRevision = unrelatedRevision;
    manifest.decisionProof.subject.certificateSha256 = sha256(Buffer.from(stringify(manifest.certificate)));
    await writeYaml(repoRoot, SOURCE_REF, manifest);
    await git(repoRoot, 'add', '--', SOURCE_REF);
    await git(repoRoot, 'commit', '-m', 'test: point manifest at unrelated source revision');
    await git(repoRoot, 'push', 'origin', 'main');

    let publications = 0;
    const rejected = await createCapabilityEvolutionMeasurementIssuer({
      repoRoot,
      programReader: { get: async () => program() },
      gitPublisher: {
        publishOnIsolatedWorktree: async () => {
          publications += 1;
          throw new Error('must not publish');
        },
      },
    }).issue({
      programId: PROGRAM_ID,
      ownerUserId: 'operator',
      catId: 'codex-sol',
      clientMessageId: 'owner-source-message-unrelated-git',
    });
    assert.equal(rejected.status, 'insufficient');
    assert.equal(rejected.reason, 'source_owner_revision_invalid');
    assert.match(rejected.detail, /not an ancestor/);
    assert.equal(publications, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});
