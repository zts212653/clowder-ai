import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createMicroduckControlSlotOwner } from '../dist/infrastructure/capability-evolution/adapters/microduck-control-slot-owner.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

const canonicalJson = (value) => `${JSON.stringify(canonicalize(value), null, 2)}\n`;
const ownerRef = (ownerStateRef, version = ownerStateRef.slice(-64)) => ({
  ownerFeatureId: 'microduck-owner',
  ownerStateRef,
  version,
});
const policyRevision = '1'.repeat(40);
const policyRef = `hf-space:pollen-robotics/microduck-simulator@${policyRevision}#app/public/policies/BEST_alpha_walking.onnx`;
const policySha256 = '2'.repeat(64);
const runnerRef = `runner:sha256:${'3'.repeat(64)}`;
const evaluationEnvRef = `evaluation-env:sha256:${'4'.repeat(64)}`;

function version(subjectId, actionScale, proof = '5') {
  const configBytes = Buffer.from(`${JSON.stringify({ actionScale, schemaVersion: 1 }, null, 2)}\n`);
  const configSha256 = sha256(configBytes);
  const configRef = `control-config:sha256:${configSha256}`;
  const artifactVersion = sha256(
    canonicalJson({
      artifactKind: 'microduck-control-package',
      configRef,
      evaluationEnvRef,
      policyRef,
      policySha256,
      runnerRef,
      schemaVersion: 1,
    }),
  );
  return {
    artifactVersionRef: {
      ownerFeatureId: 'microduck-owner',
      ownerStateRef: `control-package:sha256:${artifactVersion}`,
      version: artifactVersion,
      assetKind: 'control-package',
      assetId: subjectId,
    },
    configRef: ownerRef(configRef, configSha256),
    configBytes,
    policyVersionRef: {
      ownerFeatureId: 'microduck-owner',
      ownerStateRef: policyRef,
      version: policyRevision,
      assetKind: 'onnx-policy',
      assetId: 'walking',
    },
    policySha256,
    runnerRef: ownerRef(runnerRef),
    evaluationEnvRef: ownerRef(evaluationEnvRef),
    evaluationReceiptRef: ownerRef(`evaluation:sha256:${proof.repeat(64)}`),
    verificationReceiptRef: ownerRef(`verification:sha256:${proof.repeat(64)}`),
  };
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'f311-microduck-control-slot-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const baseline = version('baseline', 1, '5');
  const candidate = version('action-scale-110', 1.1, '6');
  const owner = createMicroduckControlSlotOwner({
    dataDir,
    initialVersion: baseline,
    now: () => '2026-09-07T05:00:00.000Z',
  });
  return { baseline, candidate, dataDir, owner };
}

describe('F311 Microduck owner-managed control slot', () => {
  it('CAS-deploys exact evaluated bytes and survives a fresh owner load', async (t) => {
    const { baseline, candidate, dataDir, owner } = await fixture(t);
    const statePath = join(dataDir, 'capability-evolution', 'microduck-owner-v1', 'control-slot.json');
    const initial = await owner.readCurrent();
    assert.equal(initial.status, 'resolved');
    assert.equal(initial.targetVersionRef.version, baseline.artifactVersionRef.version);
    await assert.rejects(stat(statePath), { code: 'ENOENT' });

    const stale = await owner.writeback({
      expectedTargetVersionRef: { ...initial.targetVersionRef, version: '0'.repeat(64) },
      candidateVersion: candidate,
      clientMessageId: 'deploy-stale',
    });
    assert.deepEqual(stale, { status: 'blocked', code: 'target_drift' });
    assert.equal((await owner.readCurrent()).targetVersionRef.version, baseline.artifactVersionRef.version);
    await assert.rejects(stat(statePath), { code: 'ENOENT' });

    const deployed = await owner.writeback({
      expectedTargetVersionRef: initial.targetVersionRef,
      candidateVersion: candidate,
      clientMessageId: 'deploy-action-scale-110',
    });
    assert.equal(deployed.status, 'deployed');
    assert.equal(deployed.deployedVersionRef.version, candidate.artifactVersionRef.version);
    assert.deepEqual(deployed.rollbackVersionRef, baseline.artifactVersionRef);
    assert.match(deployed.writebackReceiptRef.ownerStateRef, /^deploy:sha256:[a-f0-9]{64}$/u);

    const reloaded = createMicroduckControlSlotOwner({ dataDir });
    const current = await reloaded.readCurrent();
    assert.equal(current.status, 'resolved');
    assert.equal(current.targetVersionRef.version, candidate.artifactVersionRef.version);
    assert.deepEqual(current.version.artifactVersionRef, candidate.artifactVersionRef);
    assert.deepEqual(Buffer.from(current.version.configBytes), candidate.configBytes);

    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(statePath, 'utf8'), /programRef|approvalRef|proposalRef/u);
  });

  it('replays byte-identical operations and blocks id reuse with different bytes', async (t) => {
    const { candidate, owner } = await fixture(t);
    const initial = await owner.readCurrent();
    const input = {
      expectedTargetVersionRef: initial.targetVersionRef,
      candidateVersion: candidate,
      clientMessageId: 'deploy-once',
    };
    const first = await owner.writeback(input);
    assert.deepEqual(await owner.writeback(input), first);

    const collision = await owner.writeback({
      ...input,
      candidateVersion: version('action-scale-105', 1.05, '7'),
    });
    assert.deepEqual(collision, { status: 'blocked', code: 'writeback_failed' });
    assert.equal((await owner.readCurrent()).targetVersionRef.version, candidate.artifactVersionRef.version);
  });

  it('does not replay deployment or rollback success after a later state transition', async (t) => {
    const { baseline, candidate, owner } = await fixture(t);
    const initial = await owner.readCurrent();
    const deployInput = {
      expectedTargetVersionRef: initial.targetVersionRef,
      candidateVersion: candidate,
      clientMessageId: 'deploy-generation-one',
    };
    const firstDeploy = await owner.writeback(deployInput);
    assert.equal(firstDeploy.status, 'deployed');

    const rollbackInput = {
      expectedTargetVersionRef: firstDeploy.deployedVersionRef,
      rollbackVersionRef: firstDeploy.rollbackVersionRef,
      writebackReceiptRef: firstDeploy.writebackReceiptRef,
      clientMessageId: 'rollback-generation-one',
    };
    assert.equal((await owner.rollback(rollbackInput)).status, 'rolled_back');

    assert.deepEqual(await owner.writeback(deployInput), { status: 'blocked', code: 'writeback_failed' });
    assert.equal((await owner.readCurrent()).targetVersionRef.version, baseline.artifactVersionRef.version);

    const secondDeploy = await owner.writeback({ ...deployInput, clientMessageId: 'deploy-generation-two' });
    assert.equal(secondDeploy.status, 'deployed');
    assert.deepEqual(await owner.rollback(rollbackInput), { status: 'blocked', code: 'rollback_failed' });
    assert.equal((await owner.readCurrent()).targetVersionRef.version, candidate.artifactVersionRef.version);
  });

  it('restores exact stored bytes and serializes CAS across owner instances', async (t) => {
    const { baseline, candidate, dataDir, owner } = await fixture(t);
    const secondOwner = createMicroduckControlSlotOwner({ dataDir });
    const initial = await owner.readCurrent();
    const alternate = version('action-scale-105', 1.05, '7');
    const results = await Promise.all([
      owner.writeback({
        expectedTargetVersionRef: initial.targetVersionRef,
        candidateVersion: candidate,
        clientMessageId: 'race-110',
      }),
      secondOwner.writeback({
        expectedTargetVersionRef: initial.targetVersionRef,
        candidateVersion: alternate,
        clientMessageId: 'race-105',
      }),
    ]);
    assert.equal(results.filter((result) => result.status === 'deployed').length, 1);
    assert.deepEqual(
      results.find((result) => result.status === 'blocked'),
      {
        status: 'blocked',
        code: 'target_drift',
      },
    );

    const current = await owner.readCurrent();
    const deployment = results.find((result) => result.status === 'deployed');
    const rolledBack = await owner.rollback({
      expectedTargetVersionRef: current.targetVersionRef,
      rollbackVersionRef: baseline.artifactVersionRef,
      writebackReceiptRef: deployment.writebackReceiptRef,
      clientMessageId: 'restore-baseline',
    });
    assert.equal(rolledBack.status, 'rolled_back');
    assert.deepEqual(rolledBack.restoredVersionRef, baseline.artifactVersionRef);

    const reloaded = await createMicroduckControlSlotOwner({ dataDir }).readCurrent();
    assert.equal(reloaded.targetVersionRef.version, baseline.artifactVersionRef.version);
    assert.deepEqual(Buffer.from(reloaded.version.configBytes), baseline.configBytes);
  });
});
