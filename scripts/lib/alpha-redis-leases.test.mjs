import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

test('a named Alpha producer retains exact ownership after tracked serving changes, independently of preview or dev leases', (t) => {
  const f = fixture(t);
  const file = registerNamedAlphaRedisLease(f.input, f.deps);
  writeFileSync(join(f.alphaRoot, 'packages/web/package.json'), '{"generatedDuringServing":true}\n');
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

test('unreadable owner argv is reported honestly at registration, recognition and removal', (t) => {
  const f = fixture(t);
  const unavailable = { ...f.owner, command: '(bash)', argvAvailable: false };
  for (const observations of [
    [unavailable, f.owner],
    [f.owner, unavailable],
    [f.owner, { ...unavailable, ucomm: '' }],
    [unavailable, unavailable],
  ]) {
    let reads = 0;
    const capture = (pid) => (pid === 41020 ? observations[reads++] : f.redis);
    assert.throws(() => registerNamedAlphaRedisLease(f.input, { ...f.deps, capture }), /owner identity unreadable/);
    assert.equal(reads, 2, 'diagnostics must not add retries or replace the original observations');
    assert.equal(existsSync(f.registryDir), false, 'unknown ownership cannot publish a lease');
  }
  const file = registerNamedAlphaRedisLease(f.input, f.deps);
  const capture = (pid) => (pid === 41020 ? unavailable : f.redis);
  const result = readNamedAlphaRedisLeases(f.registryDir, { ...f.deps, capture });
  assert.equal(result.live.length, 0);
  assert.match(result.rejected[0].reason, /owner identity unreadable/);
  assert.throws(
    () => removeNamedAlphaRedisLease(file, 41020, { registryDir: f.registryDir, capture }),
    /owner identity unreadable/,
  );
  assert.ok(existsSync(file), 'unreadable cleanup cannot delete the original record');
});

test('failed owner captures retain their cause without claiming an incarnation change', (t) => {
  const f = fixture(t);
  const cause = new Error('fixture OS metadata read failed');
  const capture = () => {
    throw cause;
  };
  assert.throws(
    () => registerNamedAlphaRedisLease(f.input, { ...f.deps, capture }),
    (error) => {
      assert.match(error.message, /owner identity unreadable/);
      assert.equal(error.cause, cause);
      assert.ok(error.message.includes(cause.message), error.message);
      return true;
    },
  );
  assert.equal(existsSync(f.registryDir), false);
  const file = registerNamedAlphaRedisLease(f.input, f.deps);
  assert.match(
    readNamedAlphaRedisLeases(f.registryDir, { ...f.deps, capture }).rejected[0].reason,
    /owner identity unreadable/,
  );
  assert.throws(
    () => removeNamedAlphaRedisLease(file, 41020, { registryDir: f.registryDir, capture }),
    /owner identity unreadable/,
  );
  assert.ok(existsSync(file));
});

test('readable owner mismatches remain conclusive even when argv is unavailable', (t) => {
  const f = fixture(t);
  const file = registerNamedAlphaRedisLease(f.input, f.deps);
  for (const delta of [{ startedAtEpochMs: f.now }, { cwd: f.mainRoot }, { ucomm: 'node' }]) {
    const changed = { ...f.owner, ...delta, command: '(bash)', argvAvailable: false };
    const capture = (pid) => (pid === 41020 ? changed : f.redis);
    const result = readNamedAlphaRedisLeases(f.registryDir, { ...f.deps, capture });
    assert.equal(result.live.length, 0);
    assert.match(result.rejected[0].reason, /owner incarnation changed/);
    assert.throws(
      () => removeNamedAlphaRedisLease(file, 41020, { registryDir: f.registryDir, capture }),
      /another Alpha owner/,
    );
    assert.ok(existsSync(file));
  }
});

test('real lease CLI reports the failed OS capture cause and preserves the registration', (t) => {
  const f = fixture(t);
  const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', timeout: 5000 });
  assert.equal(exited.status, 0, exited.stderr);
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  const original = registerNamedAlphaRedisLease(f.input, f.deps);
  const record = JSON.parse(readFileSync(original, 'utf8'));
  record.owner.pid = exited.pid;
  const file = join(f.registryDir, `redis-${record.redis.port}-${record.redis.pid}-${exited.pid}.json`);
  const contents = JSON.stringify(record);
  writeFileSync(file, contents);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./alpha-redis-leases.mjs', import.meta.url)), 'remove', file, String(exited.pid)],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR: f.registryDir },
    },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /owner identity unreadable.*kill ESRCH/);
  assert.equal(readFileSync(file, 'utf8'), contents);
});
