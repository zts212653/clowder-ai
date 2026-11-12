import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, fstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAlphaGitTrace } from './alpha-git-trace.mjs';
import { observeAlphaGit } from './alpha-identity-diagnostics.mjs';
import { redisFixture } from './alpha-redis-process-test-fixture.mjs';

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const PRIVATE_CANARY = 'private-git-output-must-not-appear';

function failedVerification(
  t,
  {
    command,
    scope = 'main',
    timeout = false,
    stop = false,
    operation = 'verify',
    gitTrace = false,
    noTraceStorage = false,
  },
) {
  const { f, raw } = redisFixture(t);
  const bin = join(f.directory, 'observation-bin');
  const trace = join(f.directory, 'git-calls.jsonl');
  const listenerTrace = join(f.directory, 'listener-called');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}
import { appendFileSync, fstatSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const match = argv[0] === ${JSON.stringify(command)} && process.cwd() === ${JSON.stringify(scope === 'main' ? f.mainRoot : f.alphaRoot)};
const traceFd = process.env.GIT_TRACE2_EVENT === '3' ? 3 : null;
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ argv, match, traceFd,
  traceMode: traceFd ? fstatSync(traceFd).mode & 0o777 : null,
  traceLinks: traceFd ? fstatSync(traceFd).nlink : null }) + '\\n');
if (match) {
  if (${JSON.stringify(gitTrace)} && process.env.GIT_TRACE2_EVENT) {
    const events = [
      { event: 'start', argv: [${JSON.stringify(PRIVATE_CANARY)}], cwd: ${JSON.stringify(PRIVATE_CANARY)} },
      { event: 'region_enter', thread: 'main', category: 'index', label: 'preload', msg: ${JSON.stringify(PRIVATE_CANARY)} },
      { event: 'data', category: 'index', key: 'read/cache_nr', value: '105356' },
      { event: 'data', category: 'index', key: 'preload/sum_lstat', value: '105356' },
      { event: 'region_enter', category: ${JSON.stringify(PRIVATE_CANARY)}, label: ${JSON.stringify(PRIVATE_CANARY)} },
      { event: 'data', category: 'index', key: ${JSON.stringify(PRIVATE_CANARY)}, value: ${JSON.stringify(PRIVATE_CANARY)} },
    ];
    writeFileSync(traceFd,
      (${JSON.stringify(gitTrace)} === 'large' ? 'x'.repeat(100_000) + '\\n' : '') +
      events.map(event => JSON.stringify(event)).join('\\n') + '\\n');
  }
  process.stdout.write(${JSON.stringify(PRIVATE_CANARY)});
  process.stderr.write(${JSON.stringify(PRIVATE_CANARY)});
  ${timeout ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);' : ''}
  process.exit(23);
}
const child = spawnSync(${JSON.stringify(REAL_GIT)}, argv, {
  stdio: traceFd ? ['inherit', 'inherit', 'inherit', traceFd] : 'inherit',
});
process.exit(child.status ?? 1);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'lsof'),
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(listenerTrace)}, 'called');\nprocess.exit(1);\n`,
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  if (noTraceStorage) env.TMPDIR = join(f.directory, 'missing-trace-storage');
  let result;
  if (stop) {
    const launcher = readFileSync(join(f.mainRoot, 'scripts/start-dev.sh'), 'utf8');
    const functions = ['named_alpha_redis_is_owned', 'cleanup'].map((name) => {
      const source = launcher.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
      assert.ok(source, `actual launcher ${name} function`);
      return source;
    });
    result = spawnSync('bash', ['-u'], {
      env: {
        ...env,
        SCRIPT_DIR: join(f.mainRoot, 'scripts'),
        PROJECT_DIR: f.mainRoot,
        CAT_CAFE_ALPHA_COORDINATES: raw,
      },
      encoding: 'utf8',
      timeout: 15_000,
      input: `
CLEANUP_RUNNING=false
USE_REDIS=true
STARTED_REDIS=true
F247_CLOUD_OWNER_FILE=''
NAMED_ALPHA_REDIS_IDENTITY='{}'
DAEMON_PID_FILE=/nonexistent-alpha-observation-fixture
register_managed_pid() { :; }
terminate_managed_pids() { :; }
remove_redis_dev_lease() { :; }
redis_ping() { echo UNEXPECTED_REDIS_PROTOCOL; }
redis-cli() { echo UNEXPECTED_REDIS_PROTOCOL; }
kill() { echo UNEXPECTED_SIGNAL; }
remove_named_alpha_redis_lease() { echo UNEXPECTED_LEASE_REMOVAL; }
${functions.join('\n')}
cleanup
`,
    });
    assert.match(result.stderr, /cleanup incomplete; preserving named Alpha lease and data/u);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_/u);
  } else {
    result = spawnSync(
      process.execPath,
      [join(f.mainRoot, 'scripts/lib/alpha-redis-process.mjs'), operation, raw, '{}'],
      { env, encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(result.stdout, '');
  }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(listenerTrace), false, 'a failed checkout observation cannot advance to listener identity');
  assert.doesNotMatch(result.stderr, new RegExp(PRIVATE_CANARY));
  assert.equal(
    readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((r) => r.match).length,
    1,
    'Git failure does not gain a retry',
  );
  const match = result.stderr.match(/alpha_git_observation=(\{[^\n]+\})/u);
  assert.ok(match, `missing stage/timing evidence: ${result.stderr}`);
  const calls = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  return { result, observation: JSON.parse(match[1]), calls };
}

test('normal launcher cleanup exposes the Git failure while preserving Redis and its lease', (t) => {
  const { observation, result } = failedVerification(t, { command: 'diff', stop: true });
  assert.equal(observation.stage, 'main.controls-clean');
  assert.match(result.stderr, /no protocol command or signal sent/u);
});

test('trace storage failure preserves the original Git refusal without retry', (t) => {
  const { observation } = failedVerification(t, {
    command: 'status',
    scope: 'alpha',
    operation: 'capture',
    noTraceStorage: true,
  });
  assert.equal(observation.exitCode, 23);
  assert.equal(observation.trace.status, 'unavailable');
});

test('real Git uses the private descriptor and releases it on success and failure', (t) => {
  const { f } = redisFixture(t);
  const trace = createAlphaGitTrace();
  assert.ok(trace);
  const fd = trace.stdio[3];
  trace.close();
  assert.equal(observeAlphaGit(f.alphaRoot, ['rev-parse', 'HEAD'], 'witness.head'), f.head);
  assert.throws(() => fstatSync(fd), { code: 'EBADF' });
  assert.throws(
    () =>
      observeAlphaGit(f.alphaRoot, ['rev-parse', '--verify', 'refs/heads/missing-alpha-ref'], 'witness.missing-ref'),
    (error) => error.alphaGitObservation?.trace.status === 'captured' && error.alphaGitObservation.exitCode === 128,
  );
  assert.throws(() => fstatSync(fd), { code: 'EBADF' });
});

test('Redis verification reports the exact timed-out Git observation without output or retries', (t) => {
  const { observation } = failedVerification(t, { command: 'rev-parse', timeout: true });
  assert.equal(observation.stage, 'main.common-directory');
  assert.equal(observation.code, 'ETIMEDOUT');
  assert.equal(observation.timeoutMs, 5_000);
  assert.ok(observation.durationMs >= 4_900);
  assert.ok(Date.parse(observation.finishedAt) >= Date.parse(observation.startedAt));
  assert.ok(
    Object.keys(observation).every((key) =>
      [
        'v',
        'stage',
        'startedAt',
        'finishedAt',
        'durationMs',
        'timeoutMs',
        'code',
        'exitCode',
        'signal',
        'trace',
      ].includes(key),
    ),
  );
});

for (const gitTrace of [true, 'large']) {
  test(`Git failure retains bounded private phase evidence (${gitTrace}) without retry or output leakage`, (t) => {
    const { observation, calls } = failedVerification(t, {
      command: 'status',
      scope: 'alpha',
      operation: 'capture',
      gitTrace,
    });
    assert.equal(observation.exitCode, 23);
    assert.equal(observation.timeoutMs, 5_000);
    assert.equal(observation.trace?.status, 'captured');
    assert.deepEqual(observation.trace.activeRegions, ['index/preload']);
    assert.equal(observation.trace.counters['index/read/cache_nr'], 105356);
    assert.equal(observation.trace.counters['index/preload/sum_lstat'], 105356);
    assert.equal(observation.trace.truncated, gitTrace === 'large');
    for (const call of calls) {
      assert.equal(call.traceFd, 3);
      assert.equal(call.traceMode, 0o600);
      assert.equal(call.traceLinks, 0, 'raw trace has no filesystem name before Git executes');
    }
    assert.doesNotMatch(JSON.stringify(observation), new RegExp(PRIVATE_CANARY));
  });
}

for (const [command, scope, stage, refusal] of [
  ['diff', 'main', 'main.controls-clean', /committed unchanged launcher controls/u],
  ['merge-base', 'main', 'checkout.main-lineage', /outside main lineage/u],
  ['status', 'alpha', 'checkout.tracked-status', /Alpha Git observation failed/u],
]) {
  const operation = command === 'status' ? 'capture' : 'verify';
  test(`Redis ${operation} retains ${stage} evidence through checkout refusal`, (t) => {
    const { result, observation } = failedVerification(t, { command, scope, operation });
    assert.match(result.stderr, refusal);
    assert.equal(observation.stage, stage);
    assert.equal(observation.exitCode, 23);
    assert.equal(observation.timeoutMs, 5_000);
    assert.ok(observation.durationMs >= 0);
  });
}
