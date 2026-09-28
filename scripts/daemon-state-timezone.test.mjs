import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { daemonStatePaths, inspectDaemonState, writeDaemonState } from './lib/daemon-state.mjs';

const daemonStateModule = join(import.meta.dirname, 'lib', 'daemon-state.mjs');

async function withFakeDaemon(run) {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-daemon-timezone-'));
  const homeDir = join(root, 'home');
  const runtimeRoot = join(root, 'cat-cafe-runtime');
  const launchToken = 'daemon-timezone-token';
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '--', `--cat-cafe-daemon-token=${launchToken}`],
    { cwd: runtimeRoot, stdio: 'ignore' },
  );
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  try {
    await run({ child, homeDir, runtimeRoot, launchToken });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function captureIdentityInEnvironment(pid, { timezone, locale }) {
  const source = `
    const [modulePath, pid] = process.argv.slice(1);
    const { captureProcessIdentity } = await import(modulePath);
    console.log(JSON.stringify(captureProcessIdentity(Number(pid))));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, daemonStateModule, String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, TZ: timezone, LANG: locale, LC_ALL: locale },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function localProcessStart(pid, timezone) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, TZ: timezone, LANG: 'C', LC_ALL: 'C' },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().replace(/\s+/g, ' ');
}

function writeLegacyV1State({ homeDir, runtimeRoot, launchToken, child }) {
  const paths = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });
  writeDaemonState({
    paths,
    pid: child.pid,
    projectRoot: runtimeRoot,
    deploymentId: 'runtime',
    launchToken,
    logFile: join(runtimeRoot, 'cat-cafe-daemon.log'),
    ports: { frontend: 3001, api: 3002, redis: 6398 },
  });
  const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
  state.process.startedAt = localProcessStart(child.pid, 'America/Los_Angeles');
  delete state.process.startedAtFormat;
  delete state.process.startedAtEpochMs;
  writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return { paths, state };
}

test('process birth identity is stable across caller timezone and locale', () =>
  withFakeDaemon(async ({ child }) => {
    const losAngeles = captureIdentityInEnvironment(child.pid, {
      timezone: 'America/Los_Angeles',
      locale: 'en_US.UTF-8',
    });
    const tokyo = captureIdentityInEnvironment(child.pid, {
      timezone: 'Asia/Tokyo',
      locale: 'ja_JP.UTF-8',
    });

    assert.equal(losAngeles.startedAt, tokyo.startedAt);
    assert.equal(losAngeles.startedAtEpochMs, tokyo.startedAtEpochMs);
    assert.ok(Number.isSafeInteger(losAngeles.startedAtEpochMs));
    assert.equal(losAngeles.startedAtFormat, 'ps-lstart-utc-c-v1');
    assert.equal(tokyo.startedAtFormat, 'ps-lstart-utc-c-v1');
    assert.equal(losAngeles.command, tokyo.command);
    assert.equal(losAngeles.cwd, tokyo.cwd);
  }));

test('a tokenless migrated v1 state uses process-before-migration ordering across timezone', () =>
  withFakeDaemon(async (fixture) => {
    const identity = captureIdentityInEnvironment(fixture.child.pid, {
      timezone: 'UTC',
      locale: 'C',
    });
    const waitMs = identity.startedAtEpochMs + 1_000 - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs + 10));
    const { paths, state } = writeLegacyV1State(fixture);
    state.process.launchToken = null;
    state.legacyMigrated = true;
    writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const inspection = inspectDaemonState({
      stateFile: paths.stateFile,
      expectedProjectRoot: fixture.runtimeRoot,
      expectedDeploymentId: 'runtime',
    });

    assert.equal(inspection.kind, 'running');
  }));

test('a tokenless migrated v1 state rejects a process born after the state was written', () =>
  withFakeDaemon(async (fixture) => {
    const { paths, state } = writeLegacyV1State(fixture);
    const identity = captureIdentityInEnvironment(fixture.child.pid, {
      timezone: 'UTC',
      locale: 'C',
    });
    state.process.launchToken = null;
    state.legacyMigrated = true;
    state.launchedAt = new Date(identity.startedAtEpochMs - 5_000).toISOString();
    writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const inspection = inspectDaemonState({
      stateFile: paths.stateFile,
      expectedProjectRoot: fixture.runtimeRoot,
      expectedDeploymentId: 'runtime',
    });

    assert.equal(inspection.kind, 'mismatch');
    assert.equal(inspection.reason, 'process-identity-mismatch');
  }));

test('a current-format tokenless migration also rejects an ambiguous same-second incarnation', () =>
  withFakeDaemon(async (fixture) => {
    const paths = daemonStatePaths({
      homeDir: fixture.homeDir,
      projectRoot: fixture.runtimeRoot,
      deploymentId: 'runtime',
    });
    writeDaemonState({
      paths,
      pid: fixture.child.pid,
      projectRoot: fixture.runtimeRoot,
      deploymentId: 'runtime',
      launchToken: fixture.launchToken,
      logFile: join(fixture.runtimeRoot, 'cat-cafe-daemon.log'),
      ports: { frontend: 3001, api: 3002, redis: 6398 },
    });
    const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
    state.process.launchToken = null;
    state.legacyMigrated = true;
    state.launchedAt = new Date(state.process.startedAtEpochMs + 500).toISOString();
    writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const inspection = inspectDaemonState({
      stateFile: paths.stateFile,
      expectedProjectRoot: fixture.runtimeRoot,
      expectedDeploymentId: 'runtime',
    });

    assert.equal(inspection.kind, 'mismatch');
    assert.equal(inspection.reason, 'process-identity-mismatch');
  }));

test('a tokenless migrated v1 state rejects an ambiguous same-second process incarnation', () =>
  withFakeDaemon(async (fixture) => {
    const { paths, state } = writeLegacyV1State(fixture);
    const identity = captureIdentityInEnvironment(fixture.child.pid, {
      timezone: 'UTC',
      locale: 'C',
    });
    state.process.launchToken = null;
    state.legacyMigrated = true;
    state.launchedAt = new Date(identity.startedAtEpochMs + 500).toISOString();
    writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const inspection = inspectDaemonState({
      stateFile: paths.stateFile,
      expectedProjectRoot: fixture.runtimeRoot,
      expectedDeploymentId: 'runtime',
    });

    assert.equal(inspection.kind, 'mismatch');
    assert.equal(inspection.reason, 'process-identity-mismatch');
  }));

test('a token-bound legacy v1 local-time state remains valid across caller timezone', () =>
  withFakeDaemon(async (fixture) => {
    const { paths, state } = writeLegacyV1State(fixture);
    const source = `
      const [modulePath, stateFile, projectRoot] = process.argv.slice(1);
      const { inspectDaemonState } = await import(modulePath);
      const result = inspectDaemonState({
        stateFile,
        expectedProjectRoot: projectRoot,
        expectedDeploymentId: 'runtime',
      });
      console.log(JSON.stringify({ kind: result.kind, reason: result.reason }));
    `;
    const inspection = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', source, daemonStateModule, paths.stateFile, fixture.runtimeRoot],
      {
        encoding: 'utf8',
        env: { ...process.env, TZ: 'UTC', LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' },
        timeout: 10_000,
      },
    );

    assert.equal(inspection.status, 0, inspection.stderr);
    assert.equal(state.process.startedAtFormat, undefined);
    assert.deepEqual(JSON.parse(inspection.stdout), { kind: 'running' });
  }));

test('legacy v1 timezone compatibility still rejects a different launch token', () =>
  withFakeDaemon(async (fixture) => {
    const { paths, state } = writeLegacyV1State(fixture);
    state.process.launchToken = 'stale-reused-pid-token';
    writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const inspection = inspectDaemonState({
      stateFile: paths.stateFile,
      expectedProjectRoot: fixture.runtimeRoot,
      expectedDeploymentId: 'runtime',
    });

    assert.equal(inspection.kind, 'mismatch');
    assert.equal(inspection.reason, 'process-identity-mismatch');
    assert.equal(fixture.child.exitCode, null);
    assert.equal(fixture.child.signalCode, null);
  }));
