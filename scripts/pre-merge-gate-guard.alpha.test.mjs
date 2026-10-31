import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { deriveNamedAlphaCoordinates } from './lib/alpha-coordinates.mjs';
import { NAMED_ALPHA_PORTS, namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { registerNamedAlphaRedisLease } from './lib/alpha-redis-leases.mjs';
import { captureNamedAlphaRedisIdentity } from './lib/alpha-redis-process.mjs';
import { captureProcessIdentity } from './lib/process-identity.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const redisProbe = spawnSync('redis-server', ['--version'], { stdio: 'ignore' });
const missingRedis = redisProbe.error?.code === 'ENOENT';

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function captureFixtureProof(capture, expectedCommand, deadline) {
  let previous;
  let current;
  while (Date.now() < deadline) {
    current = capture();
    if (Date.now() >= deadline) break;
    if (current.process.command === expectedCommand) {
      if (isDeepStrictEqual(previous, current)) return current;
      previous = current;
    } else {
      previous = undefined;
    }
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    `isolated Redis identity readiness timeout: ${JSON.stringify({ expectedCommand, previous, current })}`,
  );
}

test('Alpha fixture publication waits for a complete and stable Unix-socket identity', async () => {
  const command = 'redis-server unixsocket:/fixture/redis.sock';
  const initializing = { process: { command: 'redis-server --port 0 --unixsocket /fixture/redis.sock' } };
  const ready = { process: { command } };
  const observations = [initializing, ready, structuredClone(ready)];
  let reads = 0;
  const proof = await captureFixtureProof(() => observations[reads++], command, Date.now() + 5000);
  assert.deepEqual(proof, ready);
  assert.equal(reads, 3, 'the identity must remain exact across consecutive observations before publication');
});

test('Alpha fixture never publishes an incomplete identity after its readiness deadline', async () => {
  const initializing = { process: { command: 'redis-server --port 0' } };
  await assert.rejects(
    captureFixtureProof(() => initializing, 'redis-server unixsocket:/fixture/redis.sock', Date.now() + 25),
    /isolated Redis identity readiness timeout.*redis-server --port 0/,
  );
});

test('gate admits an exact named Alpha producer but rejects expired and replacement listener evidence', async (t) => {
  if (missingRedis) {
    t.skip('requires redis-server for the isolated Unix-socket process-identity fixture');
    return;
  }
  const f = namedAlphaFixture(t);
  // A real registered fixture checkout and real process identities. Only the
  // socket-table observation is simulated; no port or Redis protocol is used.
  writeFileSync(join(f.mainRoot, 'scripts/start-dev.sh'), '#!/bin/bash\nprintf "READY\\n"\nread -r line\n');
  f.git(['add', 'scripts/start-dev.sh']);
  f.git(['commit', '-m', 'isolated owner process fixture']);
  f.git(['push', 'origin', 'main']);
  f.git(['fetch', 'origin', 'main']);
  f.git(['merge', '--ff-only', 'origin/main'], f.alphaRoot);
  const head = f.git(['rev-parse', 'HEAD'], f.alphaRoot);
  f.preparedBuilds(head);
  const rawCoordinates = JSON.stringify(
    deriveNamedAlphaCoordinates({
      mainRoot: f.mainRoot,
      instance: 'f290-communication',
      ports: NAMED_ALPHA_PORTS,
      targetSha: head,
    }),
  );
  const dataDir = join(f.alphaRoot, '.cat-cafe/redis');
  mkdirSync(dataDir, { recursive: true });
  const realLsof = execFileSync('which', ['lsof'], { encoding: 'utf8' }).trim();
  const owner = spawn('bash', ['./scripts/start-dev.sh'], { cwd: f.alphaRoot, stdio: ['pipe', 'pipe', 'ignore'] });
  let redis;
  let proof;
  const registrationIdentities = [];
  try {
    await once(owner.stdout, 'data');
    redis = spawn(
      'redis-server',
      [
        '--port',
        '0',
        '--unixsocket',
        join(f.directory, 'redis.sock'),
        '--dir',
        dataDir,
        '--save',
        '',
        '--appendonly',
        'no',
      ],
      { cwd: dataDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const readyDeadline = Date.now() + 5000;
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => reject(new Error(`isolated Redis readiness timeout: ${output}`)),
        Math.max(1, readyDeadline - Date.now()),
      );
      redis.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      redis.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`isolated Redis exited: ${code}/${signal}: ${output}`));
      });
      const read = (chunk) => {
        output += chunk;
        if (output.includes('Ready to accept connections')) {
          clearTimeout(timer);
          resolve();
        }
      };
      redis.stdout.on('data', read);
      redis.stderr.on('data', read);
    });
    writeFileSync(join(dataDir, 'redis-15397.pid'), `${redis.pid}\n`);
    proof = await captureFixtureProof(
      () => captureNamedAlphaRedisIdentity(rawCoordinates, { readListeners: () => [redis.pid] }),
      `redis-server unixsocket:${join(f.directory, 'redis.sock')}`,
      readyDeadline,
    );
    const registryDir = join(f.directory, 'alpha-leases');
    const leaseFile = registerNamedAlphaRedisLease(
      {
        rawCoordinates,
        redis: proof,
        ownerPid: owner.pid,
        registryDir,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        readListeners: () => [redis.pid],
        capture: (pid) => {
          const identity = captureProcessIdentity(pid);
          registrationIdentities.push({ pid, identity });
          return identity;
        },
      },
    );
    const bin = join(f.directory, 'bin');
    writeFileSync(
      join(bin, 'lsof'),
      `#!/bin/sh
case "$*" in
  *"-d cwd"*) exec ${realLsof} "$@" ;;
  *"-iTCP:15397"*) printf '%s\\n' '${redis.pid}' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const listeners = join(f.directory, 'listeners.txt');
    const ps = join(f.directory, 'ps.txt');
    writeFileSync(ps, `${process.pid} 1 100 0 node\n`);
    const setListener = (pid) =>
      writeFileSync(listeners, `redis-ser ${pid} user 6u IPv4 0x0 0t0 TCP 127.0.0.1:15397 (LISTEN)\n`);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CAT_CAFE_GATE_GUARD_SKIP_PRESSURE: '0',
      CAT_CAFE_GATE_GUARD_PS_FIXTURE: ps,
      CAT_CAFE_GATE_GUARD_LSOF_FIXTURE: listeners,
      CAT_CAFE_REDIS_TEST_REGISTRY_DIR: join(f.directory, 'test-leases'),
      CAT_CAFE_REDIS_DEV_REGISTRY_DIR: join(f.directory, 'dev-leases'),
      CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR: registryDir,
    };
    const run = () =>
      spawnSync(
        process.execPath,
        [
          process.env.CAT_CAFE_GUARD_TEST_SCRIPT || join(root, 'scripts/pre-merge-gate-guard.mjs'),
          'acquire',
          '--lock-dir',
          join(f.directory, 'guard.lock'),
          '--holder-pid',
          String(process.pid),
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env,
        },
      );
    const release = () =>
      execFileSync(
        process.execPath,
        [
          join(root, 'scripts/pre-merge-gate-guard.mjs'),
          'release',
          '--lock-dir',
          join(f.directory, 'guard.lock'),
          '--holder-pid',
          String(process.pid),
        ],
        { stdio: 'ignore' },
      );

    setListener(redis.pid);
    const inspection = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {readNamedAlphaRedisLeases} from ${JSON.stringify(join(root, 'scripts/lib/alpha-redis-leases.mjs'))}; console.log(JSON.stringify(readNamedAlphaRedisLeases()));`,
      ],
      { encoding: 'utf8', env },
    );
    assert.equal(JSON.parse(inspection.stdout).live.length, 1, inspection.stdout + inspection.stderr);
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stderr);
    release();
    const original = readFileSync(leaseFile, 'utf8');
    writeFileSync(leaseFile, JSON.stringify({ ...JSON.parse(original), expiresAt: '2000-01-01T00:00:00.000Z' }));
    const expired = run();
    assert.equal(expired.status, 1);
    assert.match(expired.stderr, /unmanaged redis-server listener on port 15397/);
    writeFileSync(leaseFile, original);
    setListener(redis.pid + 1);
    const replaced = run();
    assert.equal(replaced.status, 1);
    assert.match(replaced.stderr, /unmanaged redis-server listener on port 15397/);
    assert.equal(redis.exitCode, null, 'guard must not stop even rejected Redis ownership');
    assert.equal(owner.exitCode, null, 'guard never cancels the Alpha owner');
  } catch (error) {
    await new Promise(setImmediate);
    const status = spawnSync(
      'ps',
      ['-ww', '-p', [owner.pid, redis?.pid].filter(Boolean).join(','), '-o', 'pid=,state=,command='],
      { encoding: 'utf8' },
    );
    throw new Error(
      `${error.message}\nfixture process status: ${JSON.stringify({ ownerExit: owner.exitCode, redisExit: redis?.exitCode, redisSignal: redis?.signalCode, ps: status.stdout, proof, registrationIdentities })}`,
      { cause: error },
    );
  } finally {
    await stop(redis);
    await stop(owner);
  }
});
