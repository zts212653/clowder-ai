import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveNamedAlphaCoordinates } from './alpha-coordinates.mjs';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './alpha-named-fixture.mjs';
import { captureNamedAlphaRedisIdentity, verifyNamedAlphaRedisIdentity } from './alpha-redis-process.mjs';
import { PROCESS_START_TIME_FORMAT } from './process-identity.mjs';

function redisFixture(t) {
  const f = namedAlphaFixture(t);
  f.preparedBuilds();
  const coordinates = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'f290-communication',
    ports: NAMED_ALPHA_PORTS,
    targetSha: f.head,
  });
  const raw = JSON.stringify(coordinates);
  const dataDirectory = join(f.alphaRoot, '.cat-cafe/redis');
  mkdirSync(dataDirectory, { recursive: true });
  const pidFile = join(dataDirectory, 'redis-15397.pid');
  writeFileSync(pidFile, '41021\n');
  // Explicit OS metadata fixture; production uses canonical process-identity, never Redis INFO.
  const identity = {
    startedAt: 'Wed Sep 30 20:00:00 2026',
    startedAtEpochMs: 1790798400000,
    startedAtFormat: PROCESS_START_TIME_FORMAT,
    command: 'redis-server 127.0.0.1:15397',
    ucomm: 'redis-server',
    argvAvailable: true,
    cwd: dataDirectory,
  };
  const deps = { readListeners: () => [41021], capture: () => identity };
  return { f, raw, pidFile, identity, deps };
}

test('named Redis ownership captures the listener pidfile and canonical start identity without protocol reads', (t) => {
  const { raw, deps, identity } = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(raw, deps);
  assert.equal(proof.pid, 41021);
  assert.deepEqual(proof.process, identity);
  assert.equal(verifyNamedAlphaRedisIdentity(raw, proof, deps), true);
});

test('replacement listener or stale same PID refuses before any Redis protocol or process signal', (t) => {
  const { raw, deps, identity } = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(raw, deps);
  let osReads = 0;
  assert.throws(
    () =>
      verifyNamedAlphaRedisIdentity(raw, proof, {
        readListeners: () => [41022],
        capture: () => {
          osReads += 1;
          return identity;
        },
      }),
    /replaced/,
  );
  assert.equal(osReads, 0, 'foreign listener is rejected before even its process metadata is read');
  for (const changed of [
    { ...identity, startedAtEpochMs: identity.startedAtEpochMs + 1000 },
    { ...identity, cwd: '/foreign' },
    { ...identity, command: 'redis-server fake-alias' },
    { ...identity, ucomm: 'node' },
    { ...identity, argvAvailable: false },
  ])
    assert.throws(() => verifyNamedAlphaRedisIdentity(raw, proof, { ...deps, capture: () => changed }), /incarnation/);
});

test('pidfile aliases, unrelated PIDs and forged command aliases cannot mint ownership', (t) => {
  const { raw, deps, identity, pidFile } = redisFixture(t);
  assert.throws(() => captureNamedAlphaRedisIdentity(raw, { ...deps, readListeners: () => [41022] }), /pidfile/);
  assert.throws(
    () =>
      captureNamedAlphaRedisIdentity(raw, {
        ...deps,
        capture: () => ({ ...identity, command: 'python redis-server' }),
      }),
    /process identity/,
  );
  writeFileSync(pidFile, '9'.repeat(33));
  assert.throws(() => captureNamedAlphaRedisIdentity(raw, deps), /bounded/);
  // Use a second fixture scope for the final-component link, preserving the first fact.
  const linked = redisFixture(t);
  const other = join(linked.f.directory, 'other.pid');
  writeFileSync(other, '41021\n');
  unlinkSync(linked.pidFile);
  symlinkSync(other, linked.pidFile);
  assert.throws(() => captureNamedAlphaRedisIdentity(linked.raw, linked.deps), /regular file/);
});
