import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import {
  cleanupGateJobProcesses,
  REDIS_TEST_ROOT_TOKEN_ENV,
  scanGateJobProcesses,
} from '../../../scripts/lib/gate-job-processes.mjs';

const token = 'isolated-diagnostic-token';
const secret = 'PRIVATE_ENV_VALUE_MUST_NOT_APPEAR';
const originalGetuid = process.getuid;
before(() => {
  // Linux scanner fixtures also run on Windows without querying a real procfs.
  if (!originalGetuid) process.getuid = () => 1000;
});
after(() => {
  if (!originalGetuid) delete process.getuid;
});
const denied = (code = 'EACCES') => Object.assign(new Error(secret), { code, stderr: secret });
const linux = (overrides = {}) => ({
  platform: 'linux',
  readdirSyncImpl: () => [],
  execFileSyncImpl: () => '424242\n',
  readFileSyncImpl: () => Buffer.from('UNRELATED=value\0'),
  ...overrides,
});

for (const [operation, overrides, expected] of [
  [
    'proc-list',
    {
      readdirSyncImpl: () => {
        throw denied();
      },
    },
    { code: 'EACCES' },
  ],
  [
    'ps',
    {
      execFileSyncImpl: () => {
        throw Object.assign(denied('UNKNOWN_SECRET'), { status: 2 });
      },
    },
    { code: 'UNKNOWN', exitStatus: 2 },
  ],
  [
    'proc-environ',
    {
      readFileSyncImpl: () => {
        throw denied('EPERM');
      },
    },
    { code: 'EPERM', pid: 424242 },
  ],
]) {
  test(`Linux ${operation} failure survives cleanup without exposing error text`, async () => {
    const snapshot = scanGateJobProcesses(token, linux(overrides));
    assert.equal(snapshot.status, 'unknown');
    assert.deepEqual(snapshot.failure, { operation, ...expected });
    assert.ok(!JSON.stringify(snapshot).includes(secret));
    const proof = await cleanupGateJobProcesses({
      jobToken: token,
      cleanupBudgetMs: 100,
      scan: () => snapshot,
      killImpl: () => assert.fail('unknown ownership must not signal any process'),
    });
    assert.equal(proof.status, 'unknown');
    assert.equal(proof.tokenZeroMatches, false);
    assert.equal(proof.scanCount, 1, 'do not retry a failed scan until it happens to pass');
    assert.deepEqual(proof.failure, snapshot.failure);
  });
}

test('macOS scan errors also carry bounded diagnostics', () => {
  const snapshot = scanGateJobProcesses(token, {
    platform: 'darwin',
    execFileSyncImpl: () => {
      throw denied('ENOENT');
    },
  });
  assert.deepEqual(snapshot.failure, { operation: 'ps', code: 'ENOENT' });
  assert.ok(!JSON.stringify(snapshot).includes(secret));
});

test('a denied process after a matching process cannot become partial cleanup proof', async () => {
  const snapshot = scanGateJobProcesses(
    token,
    linux({
      execFileSyncImpl: () => '424241\n424242\n',
      readFileSyncImpl: (path) => {
        if (path === '/proc/424241/environ') return Buffer.from(`CAT_CAFE_GATE_JOB_TOKEN=${token}\0`);
        throw denied();
      },
    }),
  );
  const proof = await cleanupGateJobProcesses({
    jobToken: token,
    cleanupBudgetMs: 100,
    scan: () => snapshot,
    killImpl: () => assert.fail('incomplete scan must not signal processes'),
  });
  assert.equal(proof.tokenZeroMatches, false);
  assert.deepEqual(proof.failure, { operation: 'proc-environ', code: 'EACCES', pid: 424242 });
});

for (const code of ['ENOENT', 'ESRCH']) {
  test(`${code} from an exited process preserves exact token matching`, () => {
    const snapshot = scanGateJobProcesses(
      token,
      linux({
        tokenEnvironmentKey: REDIS_TEST_ROOT_TOKEN_ENV,
        execFileSyncImpl: () => '424241\n424242\n424243\n',
        readFileSyncImpl: (path) => {
          if (path === '/proc/424241/environ') throw denied(code);
          if (path === '/proc/424242/environ') return Buffer.from(`${REDIS_TEST_ROOT_TOKEN_ENV}=${token}\0`);
          return Buffer.from(`${REDIS_TEST_ROOT_TOKEN_ENV}=${token}-other\0`);
        },
      }),
    );
    assert.equal(snapshot.status, 'ok');
    assert.deepEqual(snapshot.processes, [{ pid: 424242, parentPid: null }]);
  });
}

test('empty successful scans still require the full settlement window', async () => {
  let now = 0;
  const proof = await cleanupGateJobProcesses({
    jobToken: token,
    cleanupBudgetMs: 200,
    settleGraceMs: 100,
    now: () => now,
    sleepImpl: async (ms) => {
      now += ms;
    },
    scan: () => scanGateJobProcesses(token, linux()),
    killImpl: () => assert.fail('unrelated process must not be signalled'),
  });
  assert.equal(proof.tokenZeroMatches, true);
  assert.ok(proof.scanCount >= 2);
  assert.ok(proof.emptySpanMs >= 100);
});

test('Redis command runner logs the safe scan failure and still exits nonzero', () => {
  // Model procfs denial in a separate process: no real /proc access or Redis.
  // This is deterministic diagnostic coverage, not reproduction of the CI cause.
  const runnerUrl = new URL('../scripts/redis-test-processes.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.getuid = () => 1000;
    const read = fs.readFileSync;
    const list = fs.readdirSync;
    fs.readdirSync = (path, ...args) => path === '/proc' ? [] : list(path, ...args);
    fs.readFileSync = (path, ...args) => {
      if (path === '/proc/424242/environ') throw Object.assign(new Error(${JSON.stringify(secret)}), { code: 'EACCES' });
      return read(path, ...args);
    };
    const exec = cp.execFileSync;
    cp.execFileSync = (file, ...args) => file === 'ps' ? '424242\\n' : exec(file, ...args);
    syncBuiltinESMExports();
    const { runTestCommand } = await import(${JSON.stringify(runnerUrl)});
    process.exitCode = await runTestCommand([process.execPath, '-e', ''], {
      cwd: process.cwd(), env: {}, signal: new AbortController().signal,
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cleanup=unknown/);
  assert.match(result.stderr, /"operation":"proc-environ"/);
  assert.match(result.stderr, /"code":"EACCES"/);
  assert.match(result.stderr, /"pid":424242/);
  assert.ok(!result.stderr.includes(secret));
});
