import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-daemon-state-'));
  const homeDir = join(root, 'home');
  const runtimeRoot = join(root, 'cat-cafe-runtime');
  const featureRoot = join(root, 'cat-cafe-feature');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(featureRoot, { recursive: true });
  tempRoots.add(root);
  return { root, homeDir, runtimeRoot, featureRoot };
}

async function spawnFakeDaemon(projectRoot, launchToken) {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '--', `--cat-cafe-daemon-token=${launchToken}`],
    { cwd: projectRoot, stdio: 'ignore' },
  );
  children.add(child);
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child;
}

async function spawnLegacyDaemon(projectRoot) {
  const scriptPath = join(projectRoot, 'scripts', 'start-dev.sh');
  mkdirSync(join(projectRoot, 'scripts'), { recursive: true });
  writeFileSync(scriptPath, '#!/usr/bin/env bash\nwhile :; do read -r -t 60 _ || true; done\n');
  const child = spawn('bash', [scriptPath], { cwd: projectRoot, stdio: 'ignore' });
  children.add(child);
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child;
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once('exit', resolve));
}

test('daemon namespaces include deployment identity and canonical project root', () => {
  const { homeDir, runtimeRoot, featureRoot } = createFixture();

  const runtime = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });
  const feature = daemonStatePaths({ homeDir, projectRoot: featureRoot, deploymentId: 'worktree' });

  assert.match(runtime.stateFile, /\.cat-cafe\/daemons\/runtime-[a-f0-9]{12}\/daemon\.json$/);
  assert.match(feature.stateFile, /\.cat-cafe\/daemons\/worktree-[a-f0-9]{12}\/daemon\.json$/);
  assert.notEqual(runtime.stateFile, feature.stateFile);
});

test('stop terminates only the exact daemon incarnation owned by the deployment', async () => {
  const { homeDir, runtimeRoot } = createFixture();
  const launchToken = 'runtime-owned-token';
  const child = await spawnFakeDaemon(runtimeRoot, launchToken);
  const paths = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });

  writeDaemonState({
    paths,
    pid: child.pid,
    projectRoot: runtimeRoot,
    deploymentId: 'runtime',
    launchToken,
    logFile: join(runtimeRoot, 'cat-cafe-daemon.log'),
    ports: { frontend: 3001, api: 3002, redis: 6399 },
  });

  const before = inspectDaemonState({
    stateFile: paths.stateFile,
    expectedProjectRoot: runtimeRoot,
    expectedDeploymentId: 'runtime',
  });
  assert.equal(before.kind, 'running');

  const result = await stopDaemon({
    paths,
    expectedProjectRoot: runtimeRoot,
    expectedDeploymentId: 'runtime',
    graceMs: 200,
  });
  await waitForExit(child);

  assert.equal(result.outcome, 'terminated');
  assert.equal(existsSync(paths.stateFile), false);
  assert.match(readFileSync(paths.auditFile, 'utf8'), /"outcome":"terminated"/);
});

test('stop fails closed when a feature worktree points at runtime state', async () => {
  const { homeDir, runtimeRoot, featureRoot } = createFixture();
  const launchToken = 'foreign-runtime-token';
  const child = await spawnFakeDaemon(runtimeRoot, launchToken);
  const paths = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });

  writeDaemonState({
    paths,
    pid: child.pid,
    projectRoot: runtimeRoot,
    deploymentId: 'runtime',
    launchToken,
    logFile: join(runtimeRoot, 'cat-cafe-daemon.log'),
    ports: { frontend: 3001, api: 3002, redis: 6399 },
  });

  await assert.rejects(
    stopDaemon({
      paths,
      expectedProjectRoot: featureRoot,
      expectedDeploymentId: 'worktree',
      graceMs: 20,
    }),
    (error) => error instanceof DaemonStateError && error.reason === 'state-owner-mismatch',
  );
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(existsSync(paths.stateFile), true);
});

test('generic start-dev --stop cannot discover a sibling runtime namespace', async () => {
  const { homeDir, runtimeRoot } = createFixture();
  const launchToken = 'generic-stop-isolation-token';
  const child = await spawnFakeDaemon(runtimeRoot, launchToken);
  const runtimePaths = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });
  writeDaemonState({
    paths: runtimePaths,
    pid: child.pid,
    projectRoot: runtimeRoot,
    deploymentId: 'runtime',
    launchToken,
    logFile: join(runtimeRoot, 'cat-cafe-daemon.log'),
    ports: { frontend: 3001, api: 3002, redis: 6399 },
  });

  const repoRoot = resolve(import.meta.dirname, '..');
  const env = { ...process.env, HOME: homeDir };
  delete env.CAT_CAFE_DEPLOYMENT_ID;
  const result = spawnSync('bash', [join(repoRoot, 'scripts', 'start-dev.sh'), '--stop'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[no-state\]/);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(existsSync(runtimePaths.stateFile), true);
});

test('stop rejects stale process identity instead of trusting a reused PID', async () => {
  const { homeDir, runtimeRoot } = createFixture();
  const launchToken = 'pid-reuse-token';
  const child = await spawnFakeDaemon(runtimeRoot, launchToken);
  const paths = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });

  writeDaemonState({
    paths,
    pid: child.pid,
    projectRoot: runtimeRoot,
    deploymentId: 'runtime',
    launchToken,
    logFile: join(runtimeRoot, 'cat-cafe-daemon.log'),
    ports: { frontend: 3001, api: 3002, redis: 6399 },
  });
  const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
  state.process.startedAt = 'definitely-not-this-process';
  writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    stopDaemon({
      paths,
      expectedProjectRoot: runtimeRoot,
      expectedDeploymentId: 'runtime',
      graceMs: 20,
    }),
    (error) => error instanceof DaemonStateError && error.reason === 'process-identity-mismatch',
  );
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(existsSync(paths.stateFile), true);
});

test('legacy global PID migration is runtime-only and validates process ownership', async () => {
  const { homeDir, runtimeRoot } = createFixture();
  const child = await spawnLegacyDaemon(runtimeRoot);
  const legacyPidFile = join(homeDir, '.cat-cafe', 'daemon.pid');
  const legacyLogPathFile = join(homeDir, '.cat-cafe', 'daemon.log-path');
  mkdirSync(join(homeDir, '.cat-cafe'), { recursive: true });
  writeFileSync(legacyPidFile, `${child.pid}\n`);
  writeFileSync(legacyLogPathFile, `${join(runtimeRoot, 'cat-cafe-daemon.log')}\n`);

  const worktreePaths = daemonStatePaths({
    homeDir,
    projectRoot: runtimeRoot,
    deploymentId: 'worktree',
  });
  const refused = migrateLegacyDaemonState({
    paths: worktreePaths,
    legacyPidFile,
    legacyLogPathFile,
    expectedProjectRoot: runtimeRoot,
    expectedDeploymentId: 'worktree',
  });
  assert.equal(refused.outcome, 'skipped');
  assert.equal(refused.reason, 'legacy-runtime-only');
  assert.equal(existsSync(legacyPidFile), true);

  const runtimePaths = daemonStatePaths({
    homeDir,
    projectRoot: runtimeRoot,
    deploymentId: 'runtime',
  });
  assert.match(captureProcessIdentity(child.pid).command, /start-dev\.sh/);
  const migrated = migrateLegacyDaemonState({
    paths: runtimePaths,
    legacyPidFile,
    legacyLogPathFile,
    expectedProjectRoot: runtimeRoot,
    expectedDeploymentId: 'runtime',
  });
  assert.equal(migrated.outcome, 'migrated');
  assert.equal(existsSync(runtimePaths.stateFile), true);
  assert.equal(existsSync(legacyPidFile), false);
  assert.equal(existsSync(legacyLogPathFile), false);

  const state = JSON.parse(readFileSync(runtimePaths.stateFile, 'utf8'));
  assert.equal(state.legacyMigrated, true);
  assert.equal(state.projectRoot, realpathSync(runtimeRoot));
  assert.equal(state.pid, child.pid);
});

test('legacy migration skips a foreign owner without aborting the runtime command', async () => {
  const { homeDir, runtimeRoot, featureRoot } = createFixture();
  const child = await spawnFakeDaemon(featureRoot, 'foreign-legacy-owner');
  const legacyPidFile = join(homeDir, '.cat-cafe', 'daemon.pid');
  const legacyLogPathFile = join(homeDir, '.cat-cafe', 'daemon.log-path');
  mkdirSync(join(homeDir, '.cat-cafe'), { recursive: true });
  writeFileSync(legacyPidFile, `${child.pid}\n`);

  const paths = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });
  const result = migrateLegacyDaemonState({
    paths,
    legacyPidFile,
    legacyLogPathFile,
    expectedProjectRoot: runtimeRoot,
    expectedDeploymentId: 'runtime',
  });

  assert.deepEqual(result, {
    outcome: 'skipped',
    reason: 'legacy-owner-mismatch',
    pid: child.pid,
    foreignCwd: realpathSync(featureRoot),
  });
  assert.equal(existsSync(paths.stateFile), false);
  assert.equal(existsSync(legacyPidFile), true);
  assert.equal(child.exitCode, null);
  assert.match(readFileSync(paths.auditFile, 'utf8'), /"reason":"legacy-owner-mismatch"/);
});

test('legacy migration refuses a same-root process without the start-dev daemon signature', async () => {
  const { homeDir, runtimeRoot } = createFixture();
  const child = await spawnFakeDaemon(runtimeRoot, 'innocent-same-root-process');
  const legacyPidFile = join(homeDir, '.cat-cafe', 'daemon.pid');
  const legacyLogPathFile = join(homeDir, '.cat-cafe', 'daemon.log-path');
  mkdirSync(join(homeDir, '.cat-cafe'), { recursive: true });
  writeFileSync(legacyPidFile, `${child.pid}\n`);

  const paths = daemonStatePaths({ homeDir, projectRoot: runtimeRoot, deploymentId: 'runtime' });
  const result = migrateLegacyDaemonState({
    paths,
    legacyPidFile,
    legacyLogPathFile,
    expectedProjectRoot: runtimeRoot,
    expectedDeploymentId: 'runtime',
  });

  assert.deepEqual(result, {
    outcome: 'skipped',
    reason: 'legacy-command-mismatch',
    pid: child.pid,
  });
  assert.equal(existsSync(paths.stateFile), false);
  assert.equal(existsSync(legacyPidFile), true);
  assert.equal(child.exitCode, null);
  assert.match(readFileSync(paths.auditFile, 'utf8'), /"reason":"legacy-command-mismatch"/);
});

test('legacy migration CLI warns but exits successfully for a foreign owner', async () => {
  const { homeDir, runtimeRoot, featureRoot } = createFixture();
  const child = await spawnFakeDaemon(featureRoot, 'foreign-legacy-cli-owner');
  const legacyPidFile = join(homeDir, '.cat-cafe', 'daemon.pid');
  mkdirSync(join(homeDir, '.cat-cafe'), { recursive: true });
  writeFileSync(legacyPidFile, `${child.pid}\n`);
  const cli = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, 'daemon-state.mjs'),
      'migrate-legacy',
      '--legacy-pid-file',
      legacyPidFile,
      '--home',
      homeDir,
      '--project-root',
      runtimeRoot,
      '--deployment-id',
      'runtime',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /WARNING \[legacy-owner-mismatch\]/);
  assert.equal(child.exitCode, null);
});
