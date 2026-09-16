import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  captureProcessIdentity,
  DaemonStateError,
  daemonStatePaths,
  inspectDaemonState,
  migrateLegacyDaemonState,
  stopDaemon,
  writeDaemonState,
} from './lib/daemon-state.mjs';

/**
 * F300 daemon identity: an unreadable argv is "unknown", never "a different
 * process" and never "the process is gone".
 *
 * macOS ps(1): "If the arguments are unavailable ... the value for the ucomm
 * keyword is appended to the arguments in parentheses"; arguments that cannot
 * be located print in square brackets. A gate observed the same PID read as
 * '(node)' and then as its full argv. The identity code took '(node)' at face
 * value: it reported a mismatch when writing state, and - the dangerous
 * direction - it let a stop conclude the daemon had exited, delete the state
 * file and record "terminated" while the process could still be alive.
 *
 * Every process here is this test's own child and every path a temp dir. The
 * unreadable reads are injected, so nothing depends on reproducing the race.
 */

const tempRoots = new Set();
const children = new Set();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  children.clear();
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-daemon-argv-'));
  const homeDir = join(root, 'home');
  const runtimeRoot = join(root, 'cat-cafe-runtime');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  tempRoots.add(root);
  return { homeDir, runtimeRoot };
}

/**
 * `ignoreSigterm` keeps the daemon alive after a polite stop. Without it the
 * child exits on SIGTERM, the real capture then throws "no such process", and a
 * stop would correctly conclude it is gone - which says nothing about what an
 * unreadable argv on a still-running process does.
 */
async function spawnFakeDaemon(projectRoot, launchToken, { ignoreSigterm = false } = {}) {
  const body = ignoreSigterm
    ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send("ready")'
    : 'setInterval(() => {}, 1000); process.send("ready")';
  const child = spawn(process.execPath, ['-e', body, '--', `--cat-cafe-daemon-token=${launchToken}`], {
    cwd: projectRoot,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.add(child);
  await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
  });
  return child;
}

/** A real ps reader, so only the field under test is replaced. */
function realPs(pid, field, env) {
  return execFileSync('ps', ['-ww', '-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8',
    env: env ?? process.env,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Real identity, but with the argv replaced by what ps prints when it cannot read it. */
function unreadable(identity, shown = '(node)') {
  return { ...identity, command: shown, argvAvailable: false };
}

function writeState({ homeDir, runtimeRoot, child, launchToken, captureIdentity }) {
  const paths = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });
  writeDaemonState({
    paths,
    pid: child.pid,
    projectRoot: runtimeRoot,
    deploymentId: 'runtime',
    launchToken,
    logFile: join(runtimeRoot, 'cat-cafe-daemon.log'),
    ports: {},
    ...(captureIdentity ? { captureIdentity } : {}),
  });
  return paths;
}

test('capture reports an unreadable argv as unavailable rather than as a command', async () => {
  const { runtimeRoot } = createFixture();
  const child = await spawnFakeDaemon(runtimeRoot, 'capture-token');

  for (const shown of ['(node)', '[kworker/0:1]']) {
    const identity = captureProcessIdentity(child.pid, {
      runPs: (pid, field, env) => (field === 'command' ? shown : realPs(pid, field, env)),
    });
    assert.equal(identity.argvAvailable, false, `${shown} must be flagged unavailable`);
  }

  const readable = captureProcessIdentity(child.pid);
  assert.equal(readable.argvAvailable, true);
  assert.match(readable.command, /--cat-cafe-daemon-token=capture-token/);
  assert.equal(typeof readable.ucomm, 'string');
});

test('writing state re-reads a transiently unreadable argv instead of calling it a mismatch', async () => {
  const fixture = createFixture();
  const launchToken = 'retry-token';
  const child = await spawnFakeDaemon(fixture.runtimeRoot, launchToken);
  let calls = 0;
  const paths = writeState({
    ...fixture,
    child,
    launchToken,
    captureIdentity: (pid) => {
      calls += 1;
      const identity = captureProcessIdentity(pid);
      return calls <= 2 ? unreadable(identity) : identity;
    },
  });
  assert.ok(calls >= 3, 'the unreadable reads must be retried');
  assert.equal(existsSync(paths.stateFile), true);
});

test('writing state fails with a distinct reason when the argv never becomes readable', async () => {
  const fixture = createFixture();
  const launchToken = 'never-readable-token';
  const child = await spawnFakeDaemon(fixture.runtimeRoot, launchToken);
  assert.throws(
    () =>
      writeState({
        ...fixture,
        child,
        launchToken,
        captureIdentity: (pid) => unreadable(captureProcessIdentity(pid)),
      }),
    (error) => error instanceof DaemonStateError && error.reason === 'spawned-process-argv-unavailable',
  );
});

test('a readable argv without the launch token is still an identity mismatch, with its readings', async () => {
  const fixture = createFixture();
  const child = await spawnFakeDaemon(fixture.runtimeRoot, 'actual-token');
  assert.throws(
    () => writeState({ ...fixture, child, launchToken: 'claimed-token' }),
    (error) =>
      error instanceof DaemonStateError &&
      error.reason === 'spawned-process-identity-mismatch' &&
      error.details?.tokenPresent === false &&
      typeof error.details?.observedCwd === 'string',
  );
});

test('inspection gives an unreadable argv its own fail-closed reason', async () => {
  const fixture = createFixture();
  const launchToken = 'inspect-token';
  const child = await spawnFakeDaemon(fixture.runtimeRoot, launchToken);
  const paths = writeState({ ...fixture, child, launchToken });

  const inspection = inspectDaemonState({
    stateFile: paths.stateFile,
    expectedProjectRoot: fixture.runtimeRoot,
    expectedDeploymentId: 'runtime',
    captureIdentity: (pid) => unreadable(captureProcessIdentity(pid)),
  });
  assert.equal(inspection.kind, 'mismatch');
  assert.equal(inspection.reason, 'process-argv-unavailable');
});

test('a stop never records "terminated" on the strength of an unreadable argv', async () => {
  const fixture = createFixture();
  const launchToken = 'stop-token';
  const child = await spawnFakeDaemon(fixture.runtimeRoot, launchToken, { ignoreSigterm: true });
  const paths = writeState({ ...fixture, child, launchToken });

  // The first read is readable, so the stop really opens against a running
  // daemon and signals it. Every later read cannot see the argv - exactly the
  // window in which the old code decided the daemon was gone.
  let calls = 0;
  const captureIdentity = (pid) => {
    calls += 1;
    const identity = captureProcessIdentity(pid);
    return calls === 1 ? identity : unreadable(identity);
  };

  await assert.rejects(
    stopDaemon({
      paths,
      expectedProjectRoot: fixture.runtimeRoot,
      expectedDeploymentId: 'runtime',
      graceMs: 200,
      captureIdentity,
    }),
    (error) => error instanceof DaemonStateError && error.reason === 'stop-outcome-unknown',
  );
  assert.equal(existsSync(paths.stateFile), true, 'state must survive an unverifiable stop');
  const audit = existsSync(paths.auditFile) ? readFileSync(paths.auditFile, 'utf8') : '';
  assert.doesNotMatch(audit, /"outcome":"terminated"/);
});

function unreadableField(field, empty = false) {
  return (pid) =>
    captureProcessIdentity(pid, {
      runPs: (target, requested, env) => {
        if (requested !== field) return realPs(target, requested, env);
        if (empty) return '';
        throw Object.assign(new Error(`Cannot read ${field}`), { code: 'EACCES' });
      },
    });
}

for (const [label, read] of [
  ['ucomm permission failure', unreadableField('ucomm')],
  ['empty command', unreadableField('command', true)],
  ['unreadable start time', unreadableField('lstart', true)],
]) {
  test(`${label} cannot make an executing daemon stale or terminated`, async () => {
    const fixture = createFixture();
    const launchToken = 'read-failure-token';
    const child = await spawnFakeDaemon(fixture.runtimeRoot, launchToken, { ignoreSigterm: true });
    const paths = writeState({ ...fixture, child, launchToken });
    const options = { paths, expectedProjectRoot: fixture.runtimeRoot, expectedDeploymentId: 'runtime' };
    const inspection = inspectDaemonState({ ...options, stateFile: paths.stateFile, captureIdentity: read });
    assert.equal(inspection.reason, 'process-identity-unreadable');
    let calls = 0;
    await assert.rejects(
      stopDaemon({
        ...options,
        graceMs: 100,
        captureIdentity: (pid) => (++calls === 1 ? captureProcessIdentity(pid) : read(pid)),
      }),
      (error) => error.reason === 'stop-outcome-unknown',
    );
    assert.equal(existsSync(paths.stateFile), true);
    process.kill(child.pid, 0);
    assert.doesNotMatch(readFileSync(paths.auditFile, 'utf8'), /"outcome":"terminated"/);
  });
}

test('spawn retries transient read errors and keeps persistent errors distinct from absence', async () => {
  const fixture = createFixture();
  const launchToken = 'spawn-read-failure-token';
  const child = await spawnFakeDaemon(fixture.runtimeRoot, launchToken);
  const read = unreadableField('ucomm');
  let calls = 0;
  writeState({
    ...fixture,
    child,
    launchToken,
    captureIdentity: (pid) => (++calls < 3 ? read(pid) : captureProcessIdentity(pid)),
  });
  assert.equal(calls, 3);
  assert.throws(
    () => writeState({ ...fixture, child, launchToken, captureIdentity: read }),
    (error) => error instanceof DaemonStateError && error.reason === 'spawned-process-identity-unreadable',
  );
});

test('a forced signal without observed exit does not authorize record cleanup', async () => {
  const fixture = createFixture();
  const launchToken = 'post-signal-observation-token';
  const child = await spawnFakeDaemon(fixture.runtimeRoot, launchToken, { ignoreSigterm: true });
  const paths = writeState({ ...fixture, child, launchToken });
  const frozen = captureProcessIdentity(child.pid);
  // The observer never reports absence, even after the force signal.
  await assert.rejects(
    stopDaemon({
      paths,
      expectedProjectRoot: fixture.runtimeRoot,
      expectedDeploymentId: 'runtime',
      graceMs: 30,
      captureIdentity: () => frozen,
    }),
    (error) => error.reason === 'stop-outcome-unknown',
  );
  assert.equal(existsSync(paths.stateFile), true);
  assert.doesNotMatch(readFileSync(paths.auditFile, 'utf8'), /"outcome":"terminated"/);
});

test('legacy migration keeps unreadable argv distinct from a readable wrong command', async () => {
  const { homeDir, runtimeRoot } = createFixture();
  const child = await spawnFakeDaemon(runtimeRoot, 'legacy-unreadable');
  const paths = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });
  const legacyPidFile = join(homeDir, 'daemon.pid');
  const legacyLogPathFile = join(homeDir, 'daemon.log-path');
  writeFileSync(legacyPidFile, `${child.pid}\n`);
  writeFileSync(legacyLogPathFile, 'legacy-log\n');
  const options = {
    paths,
    legacyPidFile,
    legacyLogPathFile,
    expectedProjectRoot: runtimeRoot,
    expectedDeploymentId: 'runtime',
  };
  const original = childProcess.execFileSync;
  try {
    for (const shown of ['(node)', '[node]', '', null]) {
      childProcess.execFileSync = (command, args, ...rest) => {
        if (command !== 'ps' || !args.includes('command=')) return original(command, args, ...rest);
        if (shown === null) throw new Error('injected ps permission error');
        return `${shown}\n`;
      };
      syncBuiltinESMExports();
      assert.deepEqual(migrateLegacyDaemonState(options), {
        outcome: 'skipped',
        reason: 'legacy-process-identity-unreadable',
      });
      assert.equal(readFileSync(legacyPidFile, 'utf8'), `${child.pid}\n`);
      assert.equal(readFileSync(legacyLogPathFile, 'utf8'), 'legacy-log\n');
      assert.equal(existsSync(paths.stateFile), false);
      assert.equal(existsSync(paths.auditFile), false, 'unknown must not leave a false mismatch audit');
    }
  } finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(migrateLegacyDaemonState(options).reason, 'legacy-command-mismatch');
});
