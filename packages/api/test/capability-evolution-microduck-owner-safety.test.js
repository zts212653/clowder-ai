import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMicroduckLocalOwnerBindings } from '../dist/infrastructure/capability-evolution/adapters/microduck-local-owner.js';
import {
  createMicroduckRuntimeAdapter,
  MicroduckOwnerRuntimeRegistration,
} from '../dist/infrastructure/capability-evolution/adapters/microduck-owner-runtime.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const programRef = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'evolution-program:5073988075254b6eac9a0de0e3a27125',
};
const objectRef = {
  ownerFeatureId: 'microduck-owner',
  ownerStateRef: 'simulator:walking',
  version: '183f99a40bd7308da3e848de961ed32bb02624a5',
};
const scope = {
  programRef,
  cycleRef: {
    ownerFeatureId: 'F311',
    ownerStateRef: `evolution-cycle:${programRef.ownerStateRef}:1`,
  },
  objectRef,
};

function runtime(bindings) {
  const registration = new MicroduckOwnerRuntimeRegistration();
  registration.connect(bindings);
  return createMicroduckRuntimeAdapter({ registration });
}

describe('F311 local Microduck owner safety boundaries', () => {
  it('keeps walking publication readable when the merged football archive drifts', async () => {
    const preparation = await createMicroduckLocalOwnerBindings({
      repoRoot,
      readBytes: async (path) => {
        const bytes = await readFile(path);
        return path.endsWith('pipeline/football/README.md')
          ? Buffer.concat([bytes, Buffer.from('\nsource drift\n')])
          : bytes;
      },
    }).preparationReview({ programRef, objectRef });

    assert.equal(preparation.status, 'resolved');
    const footballArchive = preparation.groups.find((group) => group.title === '足球公开归档（新项目尚未建制）');
    assert.ok(footballArchive);
    assert.deepEqual(
      footballArchive.items.map((item) => [item.title, item.status]),
      [['足球公开归档', 'unavailable']],
    );
    assert.equal(
      preparation.groups.flatMap((group) => group.items).filter((item) => item.candidateVersionRef).length,
      3,
    );
    assert.ok(preparation.blockers.some((item) => item.code === 'football_public_archive_unavailable'));
  });

  it('keeps every paid or mutating path closed at the credential boundary', async () => {
    const bindings = createMicroduckLocalOwnerBindings({ repoRoot });
    const adapter = runtime(bindings);
    const permissionRef = { ownerFeatureId: 'F202', ownerStateRef: 'permission:microduck-local' };

    assert.deepEqual(
      await adapter.permission({
        ...scope,
        targetVersionRef: (await adapter.observe(scope)).targetVersionRef,
        permissionRef,
        operation: 'mutate',
      }),
      { status: 'blocked', code: 'permission_missing' },
    );
    assert.deepEqual(await bindings.owner.launchMutation(), { status: 'blocked', code: 'permission_missing' });
    assert.deepEqual(await bindings.owner.writeback(), { status: 'blocked', code: 'permission_missing' });
    assert.deepEqual(await bindings.owner.rollback(), { status: 'blocked', code: 'permission_missing' });
    assert.deepEqual(await bindings.owner.collectFreshOutcome(), {
      status: 'blocked',
      code: 'fresh_outcome_missing',
    });
  });

  it('fails closed on target, policy-smoke, or capture drift', async () => {
    const valid = createMicroduckLocalOwnerBindings({ repoRoot });
    assert.deepEqual(await valid.owner.observe({ ...scope, objectRef: { ...objectRef, version: '0'.repeat(40) } }), {
      status: 'blocked',
      code: 'target_drift',
    });

    const realReadText = (path) => readFile(path, 'utf8');
    const policyUrlDrift = createMicroduckLocalOwnerBindings({
      repoRoot,
      readText: async (path) => {
        const text = await realReadText(path);
        if (!path.endsWith('policies.json')) return text;
        const value = JSON.parse(text);
        value.policies.find((policy) => policy.id === 'baseline').url = 'https://example.invalid/policy.onnx';
        return JSON.stringify(value);
      },
    });
    assert.deepEqual(await policyUrlDrift.owner.observe(scope), {
      status: 'blocked',
      code: 'artifact_hash_mismatch',
    });

    const smokeDrift = createMicroduckLocalOwnerBindings({
      repoRoot,
      readText: async (path) => {
        const text = await realReadText(path);
        if (!path.endsWith('baseline-onnx-smoke.json')) return text;
        const value = JSON.parse(text);
        value.sha256 = '0'.repeat(64);
        return JSON.stringify(value);
      },
    });
    assert.deepEqual(await smokeDrift.owner.observe(scope), {
      status: 'blocked',
      code: 'artifact_hash_mismatch',
    });

    const smokeReceiptDrift = createMicroduckLocalOwnerBindings({
      repoRoot,
      readText: async (path) => {
        const text = await realReadText(path);
        if (!path.endsWith('baseline-onnx-smoke.json')) return text;
        const value = JSON.parse(text);
        value.receiptSha256 = 'f'.repeat(64);
        return JSON.stringify(value);
      },
    });
    assert.deepEqual(await smokeReceiptDrift.owner.observe(scope), {
      status: 'blocked',
      code: 'artifact_hash_mismatch',
    });

    const captureDrift = createMicroduckLocalOwnerBindings({
      repoRoot,
      readBytes: async () => new Uint8Array([1, 2, 3]),
    });
    const descriptor = (await valid.owner.observe(scope)).sceneMedia[0];
    assert.deepEqual(
      await captureDrift.owner.resolveShowMedia({
        ...scope,
        programSequence: 1,
        sceneIndex: descriptor.sceneIndex,
        captureRef: descriptor.captureRef,
      }),
      { status: 'blocked', code: 'artifact_hash_mismatch' },
    );
  });
});
