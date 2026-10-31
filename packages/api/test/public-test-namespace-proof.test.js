import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { observeNamespaceProof, validateNamespaceProof } from '../scripts/public-test-namespace-proof.mjs';

const proof = {
  schemaVersion: 1,
  nonce: '12345678-1234-1234-1234-123456789012',
  bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  host: '4:100',
  isolated: '4:200',
};
const current = { currentNamespace: proof.isolated, bootId: proof.bootId };

describe('root launcher namespace proof', () => {
  it('accepts only this boot and the exact isolated device/inode pair', () => {
    assert.equal(validateNamespaceProof(proof, current), 'verified');
    for (const currentNamespace of [proof.host, '5:200', '4:201']) {
      assert.equal(validateNamespaceProof(proof, { ...current, currentNamespace }), 'absent');
    }
    assert.equal(validateNamespaceProof(proof, { ...current, bootId: proof.nonce }), 'absent');
  });

  it('rejects a same-host loopback even when no external device or route exists', () => {
    assert.equal(validateNamespaceProof({ ...proof, host: proof.isolated }, current), 'absent');
  });

  it('fails closed on malformed identities, missing nonce and unrecognized schema', () => {
    for (const candidate of [
      null,
      [],
      {},
      { ...proof, schemaVersion: 2 },
      { ...proof, nonce: '' },
      { ...proof, host: 'net:[100]' },
      { ...proof, isolated: '200' },
      { ...proof, bootId: 'unknown' },
    ]) {
      assert.equal(validateNamespaceProof(candidate, current), 'unknown');
    }
  });

  it('does not accept an environment opt-in or an absent launcher artifact', () => {
    assert.equal(observeNamespaceProof({ platform: 'linux', proofPath: '' }), 'absent');
    assert.equal(observeNamespaceProof({ platform: 'linux', proofPath: 'verified' }), 'unknown');
    assert.equal(
      observeNamespaceProof({ platform: 'linux', proofPath: '/definitely-missing-netns/proof.json' }),
      'absent',
    );
    assert.equal(observeNamespaceProof({ platform: 'darwin', proofPath: '/tmp/proof.json' }), 'absent');
  });

  it(
    'rejects an unprivileged forged receipt even with the right schema and read-only modes',
    {
      skip:
        process.platform === 'win32'
          ? 'requires POSIX file ownership'
          : process.getuid() === 0 && 'unprivileged forgery is exercised by the dropped Linux integration probe',
    },
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'forged-netns-'));
      const path = join(directory, 'proof.json');
      try {
        writeFileSync(path, JSON.stringify(proof));
        chmodSync(directory, 0o755);
        chmodSync(path, 0o444);
        assert.equal(observeNamespaceProof({ platform: 'linux', proofPath: path }), 'absent');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
