import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { parse, stringify } from 'yaml';

import {
  bindManifestToSourceArtifact,
  fileSourceStore,
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

async function commitGitBackedSource(repoRoot, manifest, remoteRoot) {
  if (remoteRoot) await exec('git', ['init', '--bare', remoteRoot]);
  await exec('git', ['init', '-b', 'main', repoRoot]);
  await git(repoRoot, 'config', 'user.name', 'F267 Test');
  await git(repoRoot, 'config', 'user.email', 'f267@example.invalid');
  if (remoteRoot) await git(repoRoot, 'remote', 'add', 'origin', remoteRoot);
  const sourceRef = manifest.result.cohort.ref;
  const sourceBytes = Buffer.from('kind: listener-restatement-cohort\nobservations: []\n');
  await mkdir(dirname(join(repoRoot, sourceRef)), { recursive: true });
  await writeFile(join(repoRoot, sourceRef), sourceBytes);
  await git(repoRoot, 'add', '--', sourceRef);
  await git(repoRoot, 'commit', '-m', 'test: commit source-owner input');
  const sourceRevision = await git(repoRoot, 'rev-parse', 'HEAD');
  bindManifestToSourceArtifact(manifest, { sourceRevision, ref: sourceRef, bytes: sourceBytes });
  await writeYaml(repoRoot, SOURCE_REF, manifest);
  await git(repoRoot, 'add', '--', SOURCE_REF);
  await git(repoRoot, 'commit', '-m', 'test: commit source-owner manifest');
  if (remoteRoot) await git(repoRoot, 'push', '-u', 'origin', 'main');
  return git(repoRoot, 'rev-parse', 'HEAD');
}

async function loadIssuer() {
  return import(
    '../../dist/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-issuer.js'
  );
}

describe('F267 capability-evolution measurement issuer', () => {
  it('rejects a source-message trailer injection before reading or publishing', async () => {
    const { createCapabilityEvolutionMeasurementIssuer } = await loadIssuer();
    let programReads = 0;
    let publications = 0;
    const issuer = createCapabilityEvolutionMeasurementIssuer({
      repoRoot: '/definitely/not/a/repository',
      sourceStore: fileSourceStore('/definitely/not/a/repository'),
      programReader: {
        get: async () => {
          programReads += 1;
          return program();
        },
      },
      gitPublisher: {
        publishOnIsolatedWorktree: async () => {
          publications += 1;
          throw new Error('must not publish');
        },
      },
    });

    const result = await issuer.issue({
      programId: PROGRAM_ID,
      ownerUserId: 'operator',
      catId: 'codex-sol',
      clientMessageId: 'source-a\nSource-Message: source-b',
    });

    assert.equal(result.status, 'insufficient');
    assert.equal(result.reason, 'idempotency_collision');
    assert.equal(programReads, 0);
    assert.equal(publications, 0);
  });

  it('fails closed without the canonical source-owner manifest and performs no publication', async () => {
    const { createCapabilityEvolutionMeasurementIssuer } = await loadIssuer();
    let publications = 0;
    const issuer = createCapabilityEvolutionMeasurementIssuer({
      repoRoot: '/definitely/not/a/repository',
      sourceStore: fileSourceStore('/definitely/not/a/repository'),
      programReader: { get: async () => program() },
      gitPublisher: {
        publishOnIsolatedWorktree: async () => {
          publications += 1;
          throw new Error('must not publish');
        },
      },
    });

    const result = await issuer.issue({
      programId: PROGRAM_ID,
      ownerUserId: 'operator',
      catId: 'codex-sol',
      clientMessageId: 'issue-e0-measurement',
    });

    assert.deepEqual(result, {
      status: 'insufficient',
      reason: 'source_owner_manifest_missing',
      sourceRef: {
        ownerFeatureId: 'F311',
        ownerStateRef: 'capability-evolution-measurement-source:evolution-program-bcc336788a7df9d6075b1efb4c0a7e68',
      },
      blockers: [
        'measurement_birth_contract_missing',
        'measurement_roles_missing',
        'evaluation_cohort_missing',
        'evidence_role_proof_missing',
        'consumer_consumption_receipt_missing',
        'optimizer_exposure_proof_missing',
        'independent_promotion_holdout_missing',
      ],
    });
    assert.equal(publications, 0);
  });

  it('publishes an immutable owner-bound chain without advancing the Program', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-'));
    const remoteRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-remote-'));
    try {
      const manifest = await validSourceManifest();
      const manifestRevision = await commitGitBackedSource(repoRoot, manifest, remoteRoot);
      const calls = [];
      const { createCapabilityEvolutionMeasurementIssuer } = await loadIssuer();
      const issuer = createCapabilityEvolutionMeasurementIssuer({
        repoRoot,
        sourceStore: fileSourceStore(repoRoot, { status: 'verified' }, manifestRevision),
        programReader: {
          get: async (programId) => {
            calls.push(programId);
            return program();
          },
        },
        gitPublisher: {
          publishOnIsolatedWorktree: async (options) => {
            assert.equal(options.sourceBase, manifestRevision);
            const stage = await options.stage(repoRoot);
            assert.match(stage.commitMessage, /without advancing F311/);
            return { commitSha: 'b'.repeat(40), prUrl: 'https://github.test/cat-cafe/pull/1' };
          },
        },
      });

      const result = await issuer.issue({
        programId: PROGRAM_ID,
        ownerUserId: 'operator',
        catId: 'codex-sol',
        clientMessageId: 'owner-source-message-1',
      });

      assert.equal(result.status, 'published', JSON.stringify(result));
      assert.equal(result.measurementDecisionStatus, 'insufficient');
      assert.equal(result.proofStatus, 'verified');
      assert.equal(calls.length, 1);
      assert.equal(manifest.roles.consumer.ownerStateRef, 'user:operator');
      const recordRef = `docs/harness-feedback/decision-proofs/records/${manifest.decisionProof.proofId}.yaml`;
      const recordPath = join(repoRoot, recordRef);
      const record = parse(await readFile(recordPath, 'utf8'));
      assert.equal(record.sourceAttestations[0].sha256, sha256(await readFile(join(repoRoot, SOURCE_REF))));
      assert.equal(record.sourceAttestations[0].manifestRevision, manifestRevision);
      for (const role of ['observer', 'domain_owner', 'consumer', 'calibrator']) {
        const artifact = parse(
          await readFile(
            join(repoRoot, `docs/harness-feedback/measurement-roles/${manifest.decisionProof.proofId}/${role}.yaml`),
            'utf8',
          ),
        );
        assert.equal(artifact.programId, PROGRAM_ID);
        assert.equal(artifact.source.sha256, record.sourceAttestations[0].sha256);
        if (role === 'consumer') {
          assert.deepEqual(artifact.occupantRef, { ownerFeatureId: 'F311', ownerStateRef: 'user:operator' });
        }
      }

      const sourceAttestations = record.sourceAttestations;
      delete record.sourceAttestations;
      await writeFile(recordPath, stringify(record));
      const { createFileMeasurementDecisionProofResolver } = await import(
        '../../dist/infrastructure/harness-eval/measurement/measurement-decision-proof-resolver.js'
      );
      const untrustedResolution = await createFileMeasurementDecisionProofResolver({ repoRoot }).resolve({
        ownerUserId: 'operator',
        evidenceProofRef: result.evidenceProofRef,
      });
      assert.deepEqual(untrustedResolution, { status: 'insufficient', reason: 'proof_source_mismatch' });
      const { createProgramEvaluationOwnerResolver } = await import(
        '../../dist/infrastructure/capability-evolution/program-evaluation-owner-resolver.js'
      );
      assert.equal(
        (
          await createProgramEvaluationOwnerResolver({
            decisionProofResolver: createFileMeasurementDecisionProofResolver({ repoRoot }),
          }).resolveMeasurement({ ownerUserId: 'operator', evidenceProofRef: result.evidenceProofRef })
        ).status,
        'unavailable',
      );
      record.sourceAttestations = sourceAttestations;
      await writeFile(recordPath, stringify(record));

      await writeFile(
        join(repoRoot, SOURCE_REF),
        `${await readFile(join(repoRoot, SOURCE_REF), 'utf8')}\n# live drift\n`,
      );
      assert.equal(
        (
          await createFileMeasurementDecisionProofResolver({ repoRoot }).resolve({
            ownerUserId: 'operator',
            evidenceProofRef: result.evidenceProofRef,
          })
        ).status,
        'resolved',
      );
      record.sourceAttestations[0].manifestRevision = '0'.repeat(40);
      await writeFile(recordPath, stringify(record));
      assert.deepEqual(
        await createFileMeasurementDecisionProofResolver({ repoRoot }).resolve({
          ownerUserId: 'operator',
          evidenceProofRef: result.evidenceProofRef,
        }),
        { status: 'insufficient', reason: 'proof_source_mismatch' },
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(remoteRoot, { recursive: true, force: true });
    }
  });

  it('shares one publication across concurrent delivery of the same client message', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-concurrent-'));
    const remoteRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-concurrent-remote-'));
    try {
      const manifest = await validSourceManifest();
      const manifestRevision = await commitGitBackedSource(repoRoot, manifest, remoteRoot);
      const { createCapabilityEvolutionMeasurementIssuer } = await loadIssuer();
      let publications = 0;
      const issuer = createCapabilityEvolutionMeasurementIssuer({
        repoRoot,
        sourceStore: fileSourceStore(repoRoot, { status: 'verified' }, manifestRevision),
        programReader: { get: async () => program() },
        gitPublisher: {
          publishOnIsolatedWorktree: async (options) => {
            publications += 1;
            if (publications === 1) await options.stage(repoRoot);
            return { commitSha: 'f'.repeat(40), prUrl: 'https://github.test/cat-cafe/pull/5' };
          },
        },
      });
      const input = {
        programId: PROGRAM_ID,
        ownerUserId: 'operator',
        catId: 'codex-sol',
        clientMessageId: 'owner-source-message-concurrent',
      };

      const firstPromise = issuer.issue(input);
      const collision = await issuer.issue({ ...input, ownerUserId: 'different-owner' });
      const [first, retry] = await Promise.all([firstPromise, issuer.issue(input)]);
      const cachedRetry = await issuer.issue(input);

      assert.equal(publications, 1);
      assert.equal(collision.status, 'insufficient');
      assert.equal(collision.reason, 'idempotency_collision');
      assert.deepEqual(retry, first);
      assert.deepEqual(cachedRetry, first);
      assert.equal(first.status, 'published', JSON.stringify(first));
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(remoteRoot, { recursive: true, force: true });
    }
  });

  it('recovers an already-published exact artifact chain after an issuer restart', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-reentry-'));
    const remoteRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-reentry-remote-'));
    try {
      const manifest = await validSourceManifest();
      const manifestRevision = await commitGitBackedSource(repoRoot, manifest, remoteRoot);
      const { createCapabilityEvolutionMeasurementIssuer } = await loadIssuer();
      const input = {
        programId: PROGRAM_ID,
        ownerUserId: 'operator',
        catId: 'codex-sol',
        clientMessageId: 'owner-source-message-reentry',
      };
      const first = await createCapabilityEvolutionMeasurementIssuer({
        repoRoot,
        sourceStore: fileSourceStore(repoRoot, { status: 'verified' }, manifestRevision),
        programReader: { get: async () => program() },
        gitPublisher: {
          publishOnIsolatedWorktree: async (options) => {
            await options.stage(repoRoot);
            return { commitSha: '1'.repeat(40), prUrl: 'https://github.test/cat-cafe/pull/6' };
          },
        },
      }).issue(input);
      assert.equal(first.status, 'published', JSON.stringify(first));

      let replayValidations = 0;
      const retry = await createCapabilityEvolutionMeasurementIssuer({
        repoRoot,
        sourceStore: fileSourceStore(repoRoot, { status: 'verified' }, manifestRevision),
        programReader: { get: async () => program() },
        gitPublisher: {
          publishOnIsolatedWorktree: async () => assert.fail('an exact published retry must not republish'),
          resolvePublishedOnIsolatedWorktree: async (options) => {
            replayValidations += 1;
            assert.equal(options.sourceMessageId, input.clientMessageId);
            await options.validate(repoRoot);
            return { commitSha: first.commitSha, prUrl: first.prUrl };
          },
        },
      }).issue(input);

      assert.equal(replayValidations, 1);
      assert.deepEqual(retry, first);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(remoteRoot, { recursive: true, force: true });
    }
  });

  it('publishes the birth contract and typed insufficient proof when a real holdout is absent', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-incomplete-proof-'));
    const remoteRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-incomplete-remote-'));
    try {
      const manifest = await validSourceManifest();
      delete manifest.decisionProof.promotionHoldout;
      manifest.ownerObjects = manifest.ownerObjects.filter(
        (entry) =>
          !['promotion_holdout', 'promotion_holdout_cohort', 'promotion_holdout_seal'].includes(
            entry.artifact.objectType,
          ),
      );
      const manifestRevision = await commitGitBackedSource(repoRoot, manifest, remoteRoot);
      const { createCapabilityEvolutionMeasurementIssuer } = await loadIssuer();
      const issuer = createCapabilityEvolutionMeasurementIssuer({
        repoRoot,
        sourceStore: fileSourceStore(repoRoot, { status: 'verified' }, manifestRevision),
        programReader: { get: async () => program() },
        gitPublisher: {
          publishOnIsolatedWorktree: async (options) => {
            await options.stage(repoRoot);
            return { commitSha: 'c'.repeat(40), prUrl: 'https://github.test/cat-cafe/pull/2' };
          },
        },
      });

      const result = await issuer.issue({
        programId: PROGRAM_ID,
        ownerUserId: 'operator',
        catId: 'codex-sol',
        clientMessageId: 'owner-source-message-incomplete-proof',
      });

      assert.equal(result.status, 'published', JSON.stringify(result));
      assert.equal(result.measurementDecisionStatus, 'insufficient');
      assert.equal(result.proofStatus, 'insufficient');
      const record = parse(
        await readFile(
          join(repoRoot, `docs/harness-feedback/decision-proofs/records/${manifest.decisionProof.proofId}.yaml`),
          'utf8',
        ),
      );
      assert.equal(record.candidate.promotionHoldout, undefined);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(remoteRoot, { recursive: true, force: true });
    }
  });

  it('rejects a self-consistent proof whose bare-origin source root is unresolvable or incomplete', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-forged-source-'));
    const remoteRoot = await mkdtemp(join(tmpdir(), 'f267-capability-issuer-forged-remote-'));
    try {
      const manifest = await validSourceManifest();
      const manifestRevision = await commitGitBackedSource(repoRoot, manifest, remoteRoot);
      const { createCapabilityEvolutionMeasurementIssuer } = await loadIssuer();
      const issued = await createCapabilityEvolutionMeasurementIssuer({
        repoRoot,
        sourceStore: fileSourceStore(repoRoot, { status: 'verified' }, manifestRevision),
        programReader: { get: async () => program() },
        gitPublisher: {
          publishOnIsolatedWorktree: async (options) => {
            await options.stage(repoRoot);
            return { commitSha: 'e'.repeat(40), prUrl: 'https://github.test/cat-cafe/pull/4' };
          },
        },
      }).issue({
        programId: PROGRAM_ID,
        ownerUserId: 'operator',
        catId: 'codex-sol',
        clientMessageId: 'owner-source-message-forged-root',
      });
      assert.equal(issued.status, 'published', JSON.stringify(issued));

      const recordRef = `docs/harness-feedback/decision-proofs/records/${manifest.decisionProof.proofId}.yaml`;
      const recordPath = join(repoRoot, recordRef);
      const originalRecord = parse(await readFile(recordPath, 'utf8'));
      const { createFileMeasurementDecisionProofResolver } = await import(
        '../../dist/infrastructure/harness-eval/measurement/measurement-decision-proof-resolver.js'
      );
      const { createProgramEvaluationOwnerResolver } = await import(
        '../../dist/infrastructure/capability-evolution/program-evaluation-owner-resolver.js'
      );

      for (const mutation of [
        'unresolvable_revision',
        'missing_source_artifact',
        'source_hash_mismatch',
        'manifest_not_on_origin_main',
      ]) {
        const forgedManifest = structuredClone(manifest);
        if (mutation === 'unresolvable_revision') {
          forgedManifest.sourceRevision = '0'.repeat(40);
          forgedManifest.certificate.provenance.sourceRevision = forgedManifest.sourceRevision;
          forgedManifest.decisionProof.subject.certificateSha256 = sha256(
            Buffer.from(stringify(forgedManifest.certificate)),
          );
        } else if (mutation === 'missing_source_artifact') {
          forgedManifest.sourceArtifacts = [
            {
              ownerFeatureId: 'F311',
              ref: 'docs/content/drafts/not-present.yaml',
              sha256: '0'.repeat(64),
            },
          ];
        } else if (mutation === 'source_hash_mismatch') {
          forgedManifest.sourceArtifacts[0].sha256 = '0'.repeat(64);
        }
        await writeYaml(repoRoot, SOURCE_REF, forgedManifest);
        await git(repoRoot, 'add', '--', SOURCE_REF);
        await git(repoRoot, 'commit', '-m', `test: forge ${mutation}`);
        const forgedManifestRevision = await git(repoRoot, 'rev-parse', 'HEAD');
        if (mutation !== 'manifest_not_on_origin_main') await git(repoRoot, 'push', 'origin', 'main');

        await writeYaml(repoRoot, forgedManifest.decisionProof.subject.certificateRef, forgedManifest.certificate);
        const forgedRecord = structuredClone(originalRecord);
        forgedRecord.candidate = forgedManifest.decisionProof;
        forgedRecord.sourceAttestations = [
          {
            ownerFeatureId: 'F311',
            ownerStateRef: 'capability-evolution-measurement-source:evolution-program-bcc336788a7df9d6075b1efb4c0a7e68',
            artifactRef: SOURCE_REF,
            sha256: sha256(await readFile(join(repoRoot, SOURCE_REF))),
            manifestRevision: forgedManifestRevision,
          },
        ];
        await writeFile(recordPath, stringify(forgedRecord));

        const resolver = createFileMeasurementDecisionProofResolver({ repoRoot });
        assert.deepEqual(
          await resolver.resolve({ ownerUserId: 'operator', evidenceProofRef: issued.evidenceProofRef }),
          { status: 'insufficient', reason: 'proof_source_mismatch' },
          mutation,
        );
        assert.equal(
          (
            await createProgramEvaluationOwnerResolver({ decisionProofResolver: resolver }).resolveMeasurement({
              ownerUserId: 'operator',
              evidenceProofRef: issued.evidenceProofRef,
            })
          ).status,
          'unavailable',
          mutation,
        );
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(remoteRoot, { recursive: true, force: true });
    }
  });
});
