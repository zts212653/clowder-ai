import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveGateRoute } from '../classify-gate-route.mjs';
import { writeGateContinuityClaim } from './gate-continuity-claim.mjs';
import { fixture, REPORT } from './gate-continuity-claim-fixture.mjs';
import { gateFingerprintFromComponents } from './gate-terminal-receipt.mjs';

const CLI = fileURLToPath(new URL('../gate-continuity-claim.mjs', import.meta.url));
const SECRET = 'PRIVATE_FAKE_C2_TOKEN_739a';
function invoke(f, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: f.root,
    env: { ...process.env, CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH: f.databasePath },
    encoding: 'utf8',
  });
}
function create(f, base) {
  return invoke(f, [
    'create',
    '--run-id',
    f.run.runId,
    '--base-sha',
    base,
    '--actor',
    'test-owner',
    '--source-ref',
    'thread_fixture#C2',
    '--rationale',
    'report only',
    '--assert-inert-path',
    REPORT,
  ]);
}
function assertSecretAbsent(result) {
  assert.equal(result.stdout.includes(SECRET), false, 'stdout must not expose remote credentials');
  assert.equal(result.stderr.includes(SECRET), false, 'stderr must not expose remote credentials');
}

test('credential-bearing successful remote exposes only a digest in create, artifact and inspect', (t) => {
  const f = fixture(t),
    base = f.advance();
  // Git accepts file transport with URL user-info; no external service is used.
  f.git('remote', 'set-url', 'origin', `file://user:${SECRET}@localhost${f.root}`);
  const result = create(f, base);
  assert.equal(result.status, 0, result.stderr);
  assertSecretAbsent(result);
  const { claim, claimPath, claimHash } = JSON.parse(result.stdout);
  assert.equal(readFileSync(claimPath, 'utf8').includes(SECRET), false);
  assert.equal(Object.hasOwn(claim.integration, 'url'), false);
  assert.match(claim.integration.urlDigest, /^[a-f0-9]{64}$/u);
  const inspected = invoke(f, ['inspect', '--claim-id', claimHash]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assertSecretAbsent(inspected);
  assert.equal(deriveGateRoute({ ...f.args(base), continuityClaimId: claimHash }).route, 'targeted');
  f.git('remote', 'set-url', 'origin', f.root);
  assert.equal(deriveGateRoute({ ...f.args(base), continuityClaimId: claimHash }).route, 'full');
});

test('a credential-bearing failing remote returns a bounded error without child diagnostics', (t) => {
  const f = fixture(t),
    base = f.advance();
  f.git('remote', 'set-url', 'origin', `https://user:${SECRET}@127.0.0.1:9/repo.git`);
  const result = create(f, base);
  assert.equal(result.status, 2);
  assertSecretAbsent(result);
  assert.match(result.stderr, /GATE_CONTINUITY_ORIGIN_UNAVAILABLE/u);
  assert.doesNotMatch(result.stderr, /Command failed:|https:\/\//u);
});

test('inspect never prints legacy packets containing a raw remote URL', (t) => {
  const f = fixture(t),
    base = f.advance();
  const result = create(f, base);
  assert.equal(result.status, 0, result.stderr);
  const { claimHash: _hash, ...current } = JSON.parse(result.stdout).claim;
  const legacy = {
    ...current,
    schemaVersion: 2,
    policy: 'gate-owner-c2-v2',
    integration: {
      remote: 'origin',
      ref: 'refs/heads/main',
      sha: base,
      url: `https://user:${SECRET}@example.invalid/repo`,
    },
  };
  const claimHash = gateFingerprintFromComponents(legacy);
  writeGateContinuityClaim(f.databasePath, { ...legacy, claimHash });
  const inspected = invoke(f, ['inspect', '--claim-id', claimHash]);
  assert.equal(inspected.status, 2);
  assertSecretAbsent(inspected);
});

test('inspect rejects credential-bearing extensions and keeps corrupt bytes out of diagnostics', (t) => {
  const f = fixture(t),
    base = f.advance();
  const result = create(f, base);
  assert.equal(result.status, 0, result.stderr);
  const { claimHash: _hash, ...packet } = JSON.parse(result.stdout).claim;
  const unsafe = { ...packet, integration: { ...packet.integration, url: SECRET } };
  const claimHash = gateFingerprintFromComponents(unsafe);
  const artifact = writeGateContinuityClaim(f.databasePath, { ...unsafe, claimHash });
  const inspected = invoke(f, ['inspect', '--claim-id', claimHash]);
  assert.equal(inspected.status, 2);
  assertSecretAbsent(inspected);
  writeFileSync(artifact, SECRET);
  const corrupt = invoke(f, ['inspect', '--claim-id', claimHash]);
  assert.equal(corrupt.status, 2);
  assertSecretAbsent(corrupt);
});
