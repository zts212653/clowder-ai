import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { stringify } from 'yaml';

import {
  fileSourceStore,
  PROGRAM_ID,
  program,
  SOURCE_REF,
  sha256,
  validSourceManifest,
  writeYaml,
} from './capability-evolution-measurement-fixtures.js';

async function issueFrom(repoRoot, manifest, publisher) {
  await writeYaml(repoRoot, SOURCE_REF, manifest);
  const { createCapabilityEvolutionMeasurementIssuer } = await import(
    '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-issuer.js'
  );
  return createCapabilityEvolutionMeasurementIssuer({
    repoRoot,
    sourceStore: fileSourceStore(repoRoot),
    programReader: { get: async () => program() },
    gitPublisher: { publishOnIsolatedWorktree: publisher },
  }).issue({
    programId: PROGRAM_ID,
    ownerUserId: 'operator',
    catId: 'codex-sol',
    clientMessageId: 'owner-source-message-security',
  });
}

describe('F267 capability-evolution measurement issuer security', () => {
  it('rejects an incomplete owner-object set before publication', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-invalid-'));
    try {
      const manifest = await validSourceManifest();
      manifest.ownerObjects = manifest.ownerObjects.slice(1);
      let publications = 0;
      const result = await issueFrom(repoRoot, manifest, async () => {
        publications += 1;
        throw new Error('must not publish');
      });
      assert.equal(result.status, 'insufficient');
      assert.equal(result.reason, 'source_owner_manifest_invalid');
      assert.match(result.detail, /owner object set/);
      assert.equal(publications, 0);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects owner bytes that do not bind to the claimed role or target owner', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-owner-binding-'));
    try {
      const manifest = await validSourceManifest();
      const evidenceRole = manifest.ownerObjects.find((entry) => entry.artifact.objectType === 'evidence_role');
      evidenceRole.artifact.roles = ['discovery'];
      manifest.decisionProof.evidenceRole.proof.sha256 = sha256(Buffer.from(stringify(evidenceRole.artifact)));
      let result = await issueFrom(repoRoot, manifest, async () => assert.fail('must not publish'));
      assert.equal(result.reason, 'source_owner_manifest_invalid');
      assert.match(result.detail, /owner object mismatch/);

      const wrongOwner = await validSourceManifest();
      wrongOwner.ownerObjects[0].artifact.ownerFeatureId = 'F267';
      result = await issueFrom(repoRoot, wrongOwner, async () => assert.fail('must not publish'));
      assert.equal(result.reason, 'source_owner_manifest_invalid');
      assert.match(result.detail, /owned by the source feature/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects substituting the issuing eval cat for the real user consumer', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-consumer-binding-'));
    try {
      const manifest = await validSourceManifest();
      manifest.roles.consumer = { ownerFeatureId: 'F311', ownerStateRef: 'cat:codex-sol' };
      const result = await issueFrom(repoRoot, manifest, async () => assert.fail('must not publish'));
      assert.equal(result.status, 'insufficient');
      assert.equal(result.reason, 'source_owner_manifest_invalid');
      assert.match(result.detail, /named consumer role mismatch/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects traversal-shaped artifact ids before entering the publisher', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-traversal-'));
    try {
      const manifest = await validSourceManifest();
      manifest.decisionProof.proofId = '../outside';
      const result = await issueFrom(repoRoot, manifest, async () => assert.fail('must not publish'));
      assert.equal(result.status, 'insufficient');
      assert.equal(result.reason, 'source_owner_manifest_invalid');
      assert.match(result.detail, /unsafe decision proof id/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('never follows an artifact-directory symlink outside the isolated worktree', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-symlink-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-outside-'));
    try {
      await mkdir(join(repoRoot, 'docs/harness-feedback'), { recursive: true });
      await symlink(outsideRoot, join(repoRoot, 'docs/harness-feedback/certificates'));
      const manifest = await validSourceManifest();
      const result = await issueFrom(repoRoot, manifest, async (options) => {
        await options.stage(repoRoot);
        throw new Error('stage must fail before publication');
      });
      assert.equal(result.status, 'insufficient');
      assert.equal(result.reason, 'publication_failed');
      await assert.rejects(readFile(join(outsideRoot, `${manifest.certificate.certificateId}.yaml`)), /ENOENT/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
