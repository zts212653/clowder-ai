import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveNamedAlphaCoordinates, namedAlphaEnvironment } from './lib/alpha-coordinates.mjs';
import { namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { captureNamedAlphaRedisIdentity, verifyNamedAlphaRedisIdentity } from './lib/alpha-redis-process.mjs';

const TSX_LOADER = createRequire(import.meta.url).resolve('tsx');

async function freeTuple() {
  const servers = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port).join(',');
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

async function storageFixture(t) {
  const fixtureCleanup = [];
  // Keep all temporary Git/data paths until the actual owned Redis is stopped.
  const f = namedAlphaFixture({ after: (fn) => fixtureCleanup.push(fn) });
  // Keep the real executable owner and all storage/cleanup functions; only the
  // final app-service main call is replaced by this storage consumer fixture.
  const entry = join(f.mainRoot, 'scripts/start-dev.sh');
  const source = readFileSync(entry, 'utf8');
  assert.ok(source.endsWith('main "$@"\n'));
  writeFileSync(entry, source.replace(/main "\$@"\n$/, 'source "$ALPHA_TEST_STORAGE_DRIVER"\n'));
  f.git(['add', 'scripts/start-dev.sh']);
  f.git(['commit', '-m', 'exercise real executable storage owner']);
  f.git(['push', 'origin', 'main']);
  f.git(['fetch', 'origin', 'main']);
  f.git(['merge', '--ff-only', 'origin/main'], f.alphaRoot);
  const head = f.git(['rev-parse', 'HEAD'], f.alphaRoot);
  f.preparedBuilds(head);
  const coordinates = deriveNamedAlphaCoordinates({
    mainRoot: f.mainRoot,
    instance: 'f290-communication',
    ports: await freeTuple(),
    targetSha: head,
  });
  const raw = JSON.stringify(coordinates);
  const directory = join(f.alphaRoot, '.cat-cafe/redis');
  const port = coordinates.ports.redis;
  const pidFile = join(directory, `redis-${port}.pid`);
  const registryDir = join(f.directory, 'alpha-leases');
  const env = {
    ...f.env,
    PATH: process.env.PATH,
    ...namedAlphaEnvironment(coordinates),
    CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR: registryDir,
  };
  const redis = (...args) => {
    const proof = captureNamedAlphaRedisIdentity(raw);
    verifyNamedAlphaRedisIdentity(raw, proof);
    return execFileSync('redis-cli', ['-h', '127.0.0.1', '-p', String(port), '--raw', ...args], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
  };
  t.after(() => {
    if (existsSync(pidFile)) redis('shutdown', 'nosave');
    for (const cleanup of fixtureCleanup) cleanup();
  });
  function seedRdb() {
    mkdirSync(directory, { recursive: true });
    execFileSync(
      'redis-server',
      [
        '--port',
        String(port),
        '--bind',
        '127.0.0.1',
        '--dir',
        directory,
        '--save',
        '',
        '--appendonly',
        'no',
        '--daemonize',
        'yes',
        '--pidfile',
        pidFile,
        '--logfile',
        join(directory, 'fixture-seed.log'),
      ],
      { env, timeout: 5_000 },
    );
    const original = captureNamedAlphaRedisIdentity(raw);
    redis('set', 'fixture-storage-marker', randomBytes(2048).toString('hex'));
    redis('save');
    redis('shutdown', 'nosave');
    assert.ok(existsSync(join(directory, 'dump.rdb')));
    assert.equal(existsSync(join(directory, 'appendonlydir')), false);
    return original;
  }
  function storage(extra = '', overrides = {}) {
    const consumer = `const m=await import(process.argv[1]); const {resolveNamedAlphaRuntimeBoundary}=m.default??m; const b=await resolveNamedAlphaRuntimeBoundary(process.env); const {readNamedAlphaRedisLeases}=await import(process.argv[2]); const leases=readNamedAlphaRedisLeases(); console.log('STORAGE_PROOF='+JSON.stringify({current:b.isCurrent(),redisUrl:process.env.REDIS_URL,sidecar:process.env.CAT_CAFE_PROVISION_GLOBAL_SIDECAR,leaseCount:leases.live.length}));`;
    const driver = join(f.directory, 'storage-driver.sh');
    writeFileSync(
      driver,
      `set -e\n${extra}\nsetup_storage\nredis-cli -p "$REDIS_PORT" --raw get fixture-storage-marker > "$REDIS_DATA_DIR/recovered-marker"\nnode --import "$ALPHA_TEST_TSX" --input-type=module -e "$ALPHA_TEST_CONSUMER" "$ALPHA_TEST_MODULE" "$ALPHA_TEST_LEASE_MODULE"\n`,
    );
    const result = spawnSync('bash', ['./scripts/start-dev.sh', '--quick'], {
      cwd: f.alphaRoot,
      env: {
        ...env,
        ...overrides,
        ALPHA_TEST_STORAGE_DRIVER: driver,
        ALPHA_TEST_TSX: TSX_LOADER,
        ALPHA_TEST_CONSUMER: consumer,
        ALPHA_TEST_MODULE: join(f.alphaRoot, 'packages/api/src/config/alpha-coordinates.ts'),
        ALPHA_TEST_LEASE_MODULE: join(f.alphaRoot, 'scripts/lib/alpha-redis-leases.mjs'),
      },
      encoding: 'utf8',
      timeout: 40_000,
    });
    if (existsSync(registryDir))
      assert.deepEqual(readdirSync(registryDir), [], 'launcher cleanup releases its own registration');
    return result;
  }
  return { ...f, raw, port, env, directory, pidFile, redis, seedRdb, storage };
}

test('actual storage startup preserves the tuple received by the production API coordinate consumer', async (t) => {
  const f = await storageFixture(t);
  const result = f.storage();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split('\n').find((item) => item.startsWith('STORAGE_PROOF='));
  assert.ok(line, result.stdout);
  const proof = JSON.parse(line.slice('STORAGE_PROOF='.length));
  assert.deepEqual(proof, { current: true, redisUrl: `redis://127.0.0.1:${f.port}`, sidecar: '0', leaseCount: 1 });
  assert.equal(existsSync(f.pidFile), false, 'actual launcher EXIT cleanup stops only its owned Redis');
});

test('actual RDB-first startup proves ownership before PING/AOF and recovers its own persisted keys', async (t) => {
  const f = await storageFixture(t);
  f.seedRdb();
  const result = f.storage();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /booting RDB first/);
  assert.doesNotMatch(result.stderr, /refusing unproven/);
  assert.equal(existsSync(f.pidFile), false, 'normal cleanup must leave no owned listener');
  assert.ok(existsSync(join(f.directory, 'recovered-marker')));
  assert.equal(readFileSync(join(f.directory, 'recovered-marker'), 'utf8').trim().length, 4096);
});

test('RDB-first protocol failure after native ownership capture cleans the own listener', async (t) => {
  const f = await storageFixture(t);
  f.seedRdb();
  const result = f.storage('cat_cafe_redis_enable_aof_after_rdb_boot() { return 1; }');
  assert.notEqual(result.status, 0, 'explicit AOF failure fixture must reject startup');
  assert.equal(existsSync(f.pidFile), false, 'proved owned Redis is cleaned after the startup failure');
});

test('an already occupied temp Redis remains untouched and receives no startup protocol reads', async (t) => {
  const f = await storageFixture(t);
  // This isolated Redis is deliberately not spawned by the launcher session.
  mkdirSync(f.directory, { recursive: true });
  execFileSync(
    'redis-server',
    [
      '--port',
      String(f.port),
      '--bind',
      '127.0.0.1',
      '--dir',
      f.directory,
      '--save',
      '',
      '--appendonly',
      'yes',
      '--daemonize',
      'yes',
      '--pidfile',
      f.pidFile,
      '--logfile',
      join(f.directory, 'fixture-foreign.log'),
    ],
    { env: f.env, timeout: 5_000 },
  );
  const before = captureNamedAlphaRedisIdentity(f.raw);
  f.redis('set', 'fixture-foreign-marker', 'preserved');
  const result = f.storage();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /occupied; refusing replacement or protocol reads/);
  assert.equal(verifyNamedAlphaRedisIdentity(f.raw, before), true);
  assert.equal(f.redis('get', 'fixture-foreign-marker'), 'preserved');
});

test('actual replacement PID is preserved when failed startup cleanup holds an older owned identity', async (t) => {
  const f = await storageFixture(t);
  const original = f.seedRdb();
  execFileSync(
    'redis-server',
    [
      '--port',
      String(f.port),
      '--bind',
      '127.0.0.1',
      '--dir',
      f.directory,
      '--save',
      '',
      '--appendonly',
      'yes',
      '--daemonize',
      'yes',
      '--pidfile',
      f.pidFile,
      '--logfile',
      join(f.directory, 'fixture-replacement.log'),
    ],
    { env: f.env, timeout: 5_000 },
  );
  const replacement = captureNamedAlphaRedisIdentity(f.raw);
  assert.notEqual(replacement.pid, original.pid);
  f.redis('set', 'fixture-replacement-marker', 'preserved');
  const result = f.storage('STARTED_REDIS=true\nNAMED_ALPHA_REDIS_IDENTITY="$ALPHA_TEST_OLD_IDENTITY"', {
    ALPHA_TEST_OLD_IDENTITY: JSON.stringify(original),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserving unproven or replaced named Alpha Redis/);
  assert.equal(verifyNamedAlphaRedisIdentity(f.raw, replacement), true);
  assert.equal(f.redis('get', 'fixture-replacement-marker'), 'preserved');
});
