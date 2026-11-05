import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createCapabilityEvolutionMeasurementIssuer } from '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-issuer.js';
import { createGitCapabilityEvolutionMeasurementSourceStore } from '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source-store.js';
import {
  bindManifestToSourceArtifact,
  keepProofInsufficient,
  PROGRAM_ID,
  program,
  SOURCE_REF,
  validSourceManifest,
  writeYaml,
} from './capability-evolution-measurement-fixtures.js';

const exec = promisify(execFile);

// The source, manifest and issued publication are three real local commits.
// No installed Git history, mocked trust verdict, remote fetch or network write.
export async function measurementBindingGitFixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'f330-measurement-binding-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', ['-C', repoRoot, ...args])).stdout.trim();
  const commit = async (message) => {
    await git('add', '--', '.');
    await git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Fixture Publisher');
  await git('config', 'user.email', 'fixture@example.invalid');
  const cohortRef = 'docs/eval/fixture-owner-cohort.yaml';
  const bytes = Buffer.from('kind: independent-test-cohort\nobservations: []\n');
  await mkdir(dirname(join(repoRoot, cohortRef)), { recursive: true });
  await writeFile(join(repoRoot, cohortRef), bytes);
  const sourceRevision = await commit('fixture owner input');
  const manifest = await validSourceManifest();
  keepProofInsufficient(manifest);
  bindManifestToSourceArtifact(manifest, { sourceRevision, ref: cohortRef, bytes });
  await writeYaml(repoRoot, SOURCE_REF, manifest);
  const manifestRevision = await commit('fixture owner manifest');
  await git('update-ref', 'refs/remotes/origin/main', manifestRevision);
  const issuer = createCapabilityEvolutionMeasurementIssuer({
    repoRoot,
    programReader: { get: async () => program() },
    sourceStore: createGitCapabilityEvolutionMeasurementSourceStore({ repoRoot, mainRef: 'HEAD', fetchMain: false }),
    gitPublisher: {
      async publishOnIsolatedWorktree(options) {
        assert.equal(options.sourceBase, manifestRevision);
        await options.stage(repoRoot);
        return { commitSha: await commit('fixture issued measurement'), prUrl: 'https://github.test/fixture/pull/1' };
      },
    },
  });
  const publication = await issuer.issue({
    programId: PROGRAM_ID,
    ownerUserId: 'operator',
    catId: 'codex-sol',
    clientMessageId: 'fixture-measurement-publication',
  });
  assert.equal(publication.status, 'published', JSON.stringify(publication));
  assert.equal(publication.proofStatus, 'insufficient');
  return { repoRoot, manifest, publication, git, commit, sourceRef: SOURCE_REF, projection: program() };
}
