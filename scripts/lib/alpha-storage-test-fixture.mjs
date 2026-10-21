import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { deriveNamedAlphaCoordinates, namedAlphaEnvironment } from './alpha-coordinates.mjs';
import { namedAlphaFixture } from './alpha-named-fixture.mjs';
import { captureNamedAlphaRedisIdentity, verifyNamedAlphaRedisIdentity } from './alpha-redis-process.mjs';

const TSX_LOADER = createRequire(import.meta.url).resolve('tsx');

async function freeTuple() {
  const servers = [];
  try {
    // C1 named Alpha has frontend/api/preview/redis; its Service role is retired.
    for (let index = 0; index < 4; index += 1) {
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

function injectUnreadablePostBootObservations(f) {
  const file = join(f.mainRoot, 'scripts/lib/alpha-redis-process.mjs');
  let source = readFileSync(file, 'utf8');
  source = source.replace(
    'lstatSync, readFileSync, realpathSync',
    'appendFileSync, existsSync, lstatSync, readFileSync, realpathSync',
  );
  source = source.replace(
    'captureProcessIdentity, captureReadableIdentity',
    'captureProcessIdentity as nativeCapture, captureReadableIdentity',
  );
  assert.match(source, /captureProcessIdentity as nativeCapture/);
  // Observe the real monotonic clock and protocol boundary; neither is replaced.
  source = source
    .replace('now = () => performance.now()', "now = () => recordReadinessEvent('clock', performance.now())")
    .replace(
      'run = execFileSync',
      "run = (...args) => { recordReadinessEvent('protocol'); return execFileSync(...args); }",
    )
    .replace(
      'deadline = Math.min(deadline, now() + 1_000);',
      "deadline = Math.min(deadline, now() + 1_000); recordReadinessEvent('deadline', deadline);",
    );
  source += `
function recordReadinessEvent(kind, value) {
  appendFileSync(process.env.ALPHA_TEST_READINESS_TRACE + '.budget', JSON.stringify({ kind, value }) + '\\n');
  return value;
}
function captureProcessIdentity(pid) {
  const observationStartedAt = Date.now();
  const actual = nativeCapture(pid);
  const trace = process.env.ALPHA_TEST_READINESS_TRACE;
  if (!trace || !existsSync(trace)) return actual;
  const sample = readFileSync(trace, 'utf8').split('\\n').filter(Boolean).length + 1;
  const observed = String(process.env.ALPHA_TEST_UNREADABLE_AT ?? 1).split('+').map(Number).includes(sample)
    ? { ...actual, command: '(redis-server)', argvAvailable: false }
    : actual;
  appendFileSync(trace, JSON.stringify({ pid, observationStartedAt, observationEndedAt: Date.now(), invocation: process.argv[2], ...observed }) + '\\n');
  return observed;
}
`;
  writeFileSync(file, source);
}

export async function storageFixture(t, { unreadableAfterBoot = false } = {}) {
  const fixtureCleanup = [];
  // Keep all temporary Git/data paths until the actual owned Redis is stopped.
  const f = namedAlphaFixture({ after: (fn) => fixtureCleanup.push(fn) });
  if (unreadableAfterBoot) injectUnreadablePostBootObservations(f);
  // Keep the real executable owner and all storage/cleanup functions; only the
  // final app-service main call is replaced by this storage consumer fixture.
  const entry = join(f.mainRoot, 'scripts/start-dev.sh');
  const source = readFileSync(entry, 'utf8');
  assert.ok(source.endsWith('main "$@"\n'));
  writeFileSync(entry, source.replace(/main "\$@"\n$/, 'source "$ALPHA_TEST_STORAGE_DRIVER"\n'));
  f.git(['add', 'scripts/start-dev.sh', 'scripts/lib/alpha-redis-process.mjs']);
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
  function storage(extra = '', overrides = {}, { expectRetainedRedis = false, timeout = 40_000 } = {}) {
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
      timeout,
    });
    const diagnostic = JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error ? { code: result.error.code, message: result.error.message } : null,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    assert.equal(result.error, undefined, `storage launcher execution failed: ${diagnostic}`);
    assert.notEqual(result.status, null, `storage launcher was terminated: ${diagnostic}`);
    if (existsSync(registryDir)) {
      assert.equal(
        readdirSync(registryDir).length,
        expectRetainedRedis ? 1 : 0,
        'retain ownership only when data safety prevents a saving cleanup',
      );
    }
    return result;
  }
  return { ...f, raw, port, env, directory, pidFile, redis, seedRdb, storage };
}
