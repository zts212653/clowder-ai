import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveNamedAlphaCoordinates } from './alpha-coordinates.mjs';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './alpha-named-fixture.mjs';
import {
  readNamedAlphaRedisLeases,
  registerNamedAlphaRedisLease,
  removeNamedAlphaRedisLease,
} from './alpha-redis-leases.mjs';
import { captureNamedAlphaRedisIdentity } from './alpha-redis-process.mjs';
import { PROCESS_START_TIME_FORMAT } from './process-identity.mjs';

function fixture(t) {
  const f = namedAlphaFixture(t);
  f.preparedBuilds();
  const coordinates = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'f290-communication',
    ports: NAMED_ALPHA_PORTS,
    targetSha: f.head,
  });
  const rawCoordinates = JSON.stringify(coordinates);
  const dataDirectory = join(f.alphaRoot, '.cat-cafe/redis');
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(dataDirectory, 'redis-15397.pid'), '41021\n');
  const now = Date.now();
  const owner = {
    startedAt: 'Thu Oct 1 20:00:00 2026',
    startedAtEpochMs: now - 5000,
    startedAtFormat: PROCESS_START_TIME_FORMAT,
    command: 'bash ./scripts/start-dev.sh --quick',
    ucomm: 'bash',
    argvAvailable: true,
    cwd: f.alphaRoot,
  };
  const redis = {
    ...owner,
    startedAtEpochMs: now - 3000,
    command: 'redis-server 127.0.0.1:15397',
    ucomm: 'redis-server',
    cwd: dataDirectory,
  };
  const deps = {
    now,
    readListeners: () => [41021],
    capture: (pid) => {
      assert.ok(pid === 41020 || pid === 41021, 'read only the recorded owner and Redis');
      return pid === 41020 ? owner : redis;
    },
  };
  const proof = captureNamedAlphaRedisIdentity(rawCoordinates, deps);
  const registryDir = join(f.directory, 'alpha-registry');
  const expiresAt = new Date(now + 60_000).toISOString();
  const input = { rawCoordinates, redis: proof, ownerPid: 41020, expiresAt, registryDir };
  return { ...f, now, owner, redis, proof, deps, input, registryDir, dataDirectory };
}

test('a named Alpha producer publishes exact ownership, independently of preview or dev leases', (t) => {
  const f = fixture(t);
  const file = registerNamedAlphaRedisLease(f.input, f.deps);
  const result = readNamedAlphaRedisLeases(f.registryDir, f.deps);
  assert.deepEqual(result, { live: [{ port: 15397, pid: 41021, leaseFile: file }], rejected: [] });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).kind, 'named-alpha');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).expiresAt, f.input.expiresAt);
});

test('expired ownership, absent owners, PID reuse and unknown observations cannot admit a listener', (t) => {
  const f = fixture(t);
  const file = registerNamedAlphaRedisLease(f.input, f.deps);
  const rejectedObservations = [
    { ...f.deps, now: f.now + 60_000 },
    {
      ...f.deps,
      capture: () => {
        throw new Error('owner unavailable');
      },
    },
    { ...f.deps, readListeners: () => [41022] },
    {
      ...f.deps,
      capture: (pid) => (pid === 41020 ? { ...f.owner, startedAtEpochMs: f.now } : f.redis),
    },
    {
      ...f.deps,
      capture: (pid) => (pid === 41020 ? f.owner : { ...f.redis, startedAtEpochMs: f.now }),
    },
    { ...f.deps, capture: () => ({ ...f.owner, argvAvailable: false }) },
  ];
  for (const deps of rejectedObservations) {
    const result = readNamedAlphaRedisLeases(f.registryDir, deps);
    assert.equal(result.live.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(existsSync(file), 'recognition never deletes rejected ownership evidence');
  }
});

test('wrong coordinates, foreign data, forged owner commands and invalid expiry cannot be published', (t) => {
  const f = fixture(t);
  assert.throws(() => registerNamedAlphaRedisLease({ ...f.input, expiresAt: 'forged' }, f.deps), /lifetime/);
  assert.throws(
    () => registerNamedAlphaRedisLease({ ...f.input, expiresAt: new Date(f.now).toISOString() }, f.deps),
    /expired/,
  );
  assert.throws(
    () => registerNamedAlphaRedisLease({ ...f.input, redis: { ...f.proof, dataDirectory: '/foreign' } }, f.deps),
    /proof/,
  );
  const coordinates = JSON.parse(f.input.rawCoordinates);
  coordinates.ports.redis = 6399;
  assert.throws(
    () => registerNamedAlphaRedisLease({ ...f.input, rawCoordinates: JSON.stringify(coordinates) }, f.deps),
    /protected/,
  );
  for (const changed of [
    { ...f.owner, cwd: f.mainRoot },
    { ...f.owner, command: 'python ./scripts/start-dev.sh' },
    { ...f.owner, command: 'bash ./other.sh' },
    { ...f.owner, command: 'bash -c source ./scripts/start-dev.sh' },
    { ...f.owner, ucomm: 'node' },
  ])
    assert.throws(
      () => registerNamedAlphaRedisLease(f.input, { ...f.deps, capture: (pid) => (pid === 41020 ? changed : f.redis) }),
      /owner incarnation/,
    );
});

test('preview metadata and symlinked records do not authorize Redis ownership', (t) => {
  const f = fixture(t);
  const file = registerNamedAlphaRedisLease(f.input, f.deps);
  const original = readFileSync(file);
  writeFileSync(file, JSON.stringify({ version: 1, command: ['pnpm', 'alpha:start'], expiresAt: f.input.expiresAt }));
  assert.equal(readNamedAlphaRedisLeases(f.registryDir, f.deps).live.length, 0);
  writeFileSync(file, original);
  const target = join(f.directory, 'other-record');
  writeFileSync(target, original);
  unlinkSync(file);
  symlinkSync(target, file);
  assert.equal(readNamedAlphaRedisLeases(f.registryDir, f.deps).live.length, 0);
  assert.ok(existsSync(target));
});

test('owner cleanup removes only its registration even after expiry, preserving Alpha data', (t) => {
  const f = fixture(t);
  const file = registerNamedAlphaRedisLease(f.input, f.deps);
  const data = join(f.dataDirectory, 'dump.rdb');
  writeFileSync(data, 'persistent Alpha data');
  assert.throws(
    () => removeNamedAlphaRedisLease(file, 41022, { ...f.deps, registryDir: f.registryDir }),
    /another Alpha/,
  );
  assert.ok(existsSync(file));
  const record = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...record, expiresAt: new Date(f.now - 1).toISOString() }));
  removeNamedAlphaRedisLease(file, 41020, { registryDir: f.registryDir, capture: f.deps.capture });
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(data, 'utf8'), 'persistent Alpha data');
});
