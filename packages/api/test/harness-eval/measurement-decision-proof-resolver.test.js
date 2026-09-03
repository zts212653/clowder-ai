// @ts-check

import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parse, stringify } from 'yaml';

import {
  CERTIFICATE_REF,
  fixture,
  moduleUnderTest,
  OWNER_KEYS,
  OWNER_ROOT,
  PROOF_ID,
  PROOF_REF,
  RESULT_REF,
  replaceWithOutsideSymlink,
  resolveFixture,
  sha256,
} from './f267-proof-fixture.helper.mjs';

describe('F267 measurement decision proof ref resolver', () => {
  it('resolves only a canonical owner-backed proof chain', async () => {
    const testFixture = await fixture();
    try {
      const resolution = await resolveFixture(testFixture);
      assert.equal(resolution.status, 'resolved', JSON.stringify(resolution));
      assert.equal(resolution.proof.status, 'verified');
      assert.equal(resolution.proof.proofId, PROOF_ID);
    } finally {
      await testFixture.cleanup();
    }
  });

  it('fails closed for unknown, malformed, and user-mismatched refs', async () => {
    const { createFileMeasurementDecisionProofResolver } = await moduleUnderTest();
    const testFixture = await fixture();
    try {
      const resolver = createFileMeasurementDecisionProofResolver({ repoRoot: testFixture.repoRoot });
      assert.deepEqual(
        await resolver.resolve({
          ownerUserId: 'operator',
          evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:missing-proof' },
        }),
        { status: 'insufficient', reason: 'unknown_proof_ref' },
      );
      assert.deepEqual(await resolver.resolve({ ownerUserId: 'another-user', evidenceProofRef: PROOF_REF }), {
        status: 'insufficient',
        reason: 'proof_owner_mismatch',
      });
      assert.deepEqual(
        await resolver.resolve({
          ownerUserId: 'operator',
          evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:../escape' },
        }),
        { status: 'insufficient', reason: 'invalid_proof_ref' },
      );
    } finally {
      await testFixture.cleanup();
    }
  });

  it('rejects missing and hash-mismatched bytes for every claimed owner object', async () => {
    for (const key of OWNER_KEYS) {
      const missing = await fixture();
      try {
        await unlink(join(missing.repoRoot, missing.refs[key]));
        assert.deepEqual(await resolveFixture(missing), { status: 'insufficient', reason: 'proof_source_mismatch' });
      } finally {
        await missing.cleanup();
      }

      const drifted = await fixture();
      try {
        await writeFile(
          join(drifted.repoRoot, drifted.refs[key]),
          Buffer.concat([drifted.bytes[key], Buffer.from('# drift\n')]),
        );
        assert.deepEqual(await resolveFixture(drifted), { status: 'insufficient', reason: 'proof_source_mismatch' });
      } finally {
        await drifted.cleanup();
      }
    }
  });

  it('rejects correctly hashed owner bytes that do not bind to the candidate claim', async () => {
    const testFixture = await fixture();
    try {
      const roleObject = parse(
        (await readFile(join(testFixture.repoRoot, testFixture.refs.evidenceRole))).toString('utf8'),
      );
      roleObject.roles = ['discovery'];
      const roleBytes = Buffer.from(stringify(roleObject));
      await writeFile(join(testFixture.repoRoot, testFixture.refs.evidenceRole), roleBytes);
      const recordPath = join(testFixture.repoRoot, testFixture.recordRef);
      const record = parse(await readFile(recordPath, 'utf8'));
      record.candidate.evidenceRole.proof.sha256 = sha256(roleBytes);
      await writeFile(recordPath, stringify(record));

      assert.deepEqual(await resolveFixture(testFixture), { status: 'insufficient', reason: 'proof_source_mismatch' });
    } finally {
      await testFixture.cleanup();
    }
  });

  it('rejects owner identity drift even when the owner object hash is current', async () => {
    const testFixture = await fixture();
    try {
      const objectPath = join(testFixture.repoRoot, testFixture.refs.evidenceRole);
      const roleObject = parse(await readFile(objectPath, 'utf8'));
      roleObject.ownerUserId = 'another-user';
      const roleBytes = Buffer.from(stringify(roleObject));
      await writeFile(objectPath, roleBytes);
      const recordPath = join(testFixture.repoRoot, testFixture.recordRef);
      const record = parse(await readFile(recordPath, 'utf8'));
      record.candidate.evidenceRole.proof.sha256 = sha256(roleBytes);
      await writeFile(recordPath, stringify(record));

      assert.deepEqual(await resolveFixture(testFixture), { status: 'insufficient', reason: 'proof_source_mismatch' });
    } finally {
      await testFixture.cleanup();
    }
  });

  it('rejects certificate and result hash drift', async () => {
    for (const ref of [CERTIFICATE_REF, RESULT_REF]) {
      const testFixture = await fixture();
      try {
        const target = join(testFixture.repoRoot, ref);
        await writeFile(target, Buffer.concat([await readFile(target), Buffer.from('# drift\n')]));
        assert.deepEqual(await resolveFixture(testFixture), {
          status: 'insufficient',
          reason: 'proof_source_mismatch',
        });
      } finally {
        await testFixture.cleanup();
      }
    }
  });

  it('rejects symlink escapes for records, certificate/result, and every owner object', async () => {
    const targets = ['record', 'certificate', 'result', ...OWNER_KEYS];
    for (const target of targets) {
      const testFixture = await fixture();
      try {
        const ref =
          target === 'record'
            ? testFixture.recordRef
            : target === 'certificate'
              ? CERTIFICATE_REF
              : target === 'result'
                ? RESULT_REF
                : testFixture.refs[target];
        await replaceWithOutsideSymlink(testFixture, ref);
        assert.equal((await resolveFixture(testFixture)).status, 'insufficient', target);
      } finally {
        await testFixture.cleanup();
      }
    }
  });
});
