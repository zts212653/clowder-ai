import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { daemonStatePaths, writeDaemonState } from '../../../scripts/lib/daemon-state.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const launchPrefix = existsSync(join(repoRoot, 'sync-manifest.yaml'))
  ? '--prod-web\n'
  : '--prod-web\n--profile=opensource\n';
const CROSS_TIMEZONE_ENV = { TZ: 'UTC', LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' };
const revision = 'a'.repeat(40);
const roots = new Set();
const children = new Set();
const haltWord = 'stop';
const relaunchWord = 'restart';
const haltScript = 'runtime:stop';
const relaunchScript = 'runtime:restart';

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((done) => child.once('exit', done));
    }
  }
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function copyRuntimeFile(projectRoot, relativePath) {
  const target = join(projectRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(repoRoot, relativePath), target);
}

function seedRuntimeArtifacts(projectRoot) {
  for (const [pkg, dir, file] of [
    ['shared', 'dist', 'index.js'],
    ['api', 'dist', 'index.js'],
    ['mcp-server', 'dist', 'index.js'],
    ['web', '.next', 'BUILD_ID'],
  ]) {
    const artifactDir = join(projectRoot, 'packages', pkg, dir);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, file), 'fixture\n');
    writeFileSync(join(artifactDir, '.build-commit'), `${revision}\n`);
  }
  mkdirSync(join(projectRoot, 'node_modules', '.pnpm'), { recursive: true });
  for (const [pkg, dep] of [
    ['web', 'next'],
    ['api', 'tsx'],
    ['mcp-server', 'typescript'],
  ]) {
    const depRoot = join(projectRoot, 'packages', pkg, 'node_modules', dep);
    mkdirSync(depRoot, { recursive: true });
    writeFileSync(join(depRoot, 'package.json'), '{}');
  }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-command-lifecycle-'));
  roots.add(root);
  const projectRoot = join(root, 'archive');
  const homeDir = join(root, 'home');
  const marker = join(root, 'started-args.txt');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const operationPrefix = `scripts/lib/daemon-${haltWord}`;
  for (const path of [
    'scripts/start-entry.mjs',
    'scripts/runtime-worktree.sh',
    'scripts/daemon-state.mjs',
    'scripts/lib/platform-status.mjs',
    'scripts/lib/quickstart-freshness.sh',
    'scripts/lib/node-runtime-guard.sh',
    'scripts/lib/daemon-state.mjs',
    'scripts/lib/process-identity.mjs',
    'scripts/lib/daemon-health-probe.mjs',
    `${operationPrefix}-operation.mjs`,
    `${operationPrefix}-record.mjs`,
    `${operationPrefix}-claim.mjs`,
    'scripts/lib/process-tree.mjs',
  ]) {
    copyRuntimeFile(projectRoot, path);
  }

  writeFileSync(
    join(projectRoot, 'scripts', 'start-dev.sh'),
    '#!/bin/bash\nprintf "%s\\n" "$@" > "$RUNTIME_COMMAND_MARKER"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(projectRoot, '.cat-cafe-runtime-revision'), `${revision}\n`);
  seedRuntimeArtifacts(projectRoot);

  const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({
      private: true,
      scripts: {
        start: scripts.start,
        'runtime:start': scripts['runtime:start'],
        [relaunchScript]: scripts[relaunchScript],
        [haltScript]: scripts[haltScript],
      },
    })}\n`,
  );

  return { projectRoot, homeDir, marker };
}

function runPnpm(fixture, script, args = [], extraEnv = {}) {
  return spawnSync('pnpm', [script, ...args], {
    cwd: fixture.projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      ...extraEnv,
      HOME: fixture.homeDir,
      CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
      API_SERVER_PORT: '19876',
      FRONTEND_PORT: '19875',
      PREVIEW_GATEWAY_PORT: '0',
      RUNTIME_COMMAND_MARKER: fixture.marker,
    },
  });
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

function rewriteAsLegacyV1LocalTime(paths, pid, timezone) {
  const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
  state.process.startedAt = localProcessStart(pid, timezone);
  delete state.process.startedAtFormat;
  delete state.process.startedAtEpochMs;
  writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function rewriteAsAmbiguousTokenlessLegacyV1(paths, pid, timezone) {
  const state = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
  const processBirthEpochMs = state.process.startedAtEpochMs;
  state.process.startedAt = localProcessStart(pid, timezone);
  delete state.process.startedAtFormat;
  delete state.process.startedAtEpochMs;
  state.process.launchToken = null;
  state.legacyMigrated = true;
  state.launchedAt = new Date(processBirthEpochMs + 500).toISOString();
  writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function seedManagedDaemon(fixture, { legacyTimezone } = {}) {
  const launchToken = 'runtime-command-token';
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', '--', `--cat-cafe-daemon-token=${launchToken}`],
    { cwd: fixture.projectRoot, stdio: 'ignore' },
  );
  children.add(child);
  await new Promise((done, fail) => {
    child.once('spawn', done);
    child.once('error', fail);
  });
  const paths = daemonStatePaths({
    homeDir: fixture.homeDir,
    projectRoot: fixture.projectRoot,
    deploymentId: 'runtime',
  });
  writeDaemonState({
    paths,
    pid: child.pid,
    projectRoot: fixture.projectRoot,
    deploymentId: 'runtime',
    launchToken,
    logFile: join(fixture.projectRoot, 'cat-cafe-daemon.log'),
    ports: { api: 19876 },
  });
  if (legacyTimezone) rewriteAsLegacyV1LocalTime(paths, child.pid, legacyTimezone);
  return child;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnListener(cwd) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      'const net=require("node:net");const server=net.createServer();' +
        'server.listen(0,"127.0.0.1",()=>process.stdout.write(String(server.address().port)+"\\n"));' +
        'process.on("SIGTERM",()=>server.close(()=>process.exit(0)));',
    ],
    { cwd, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.add(child);
  const [chunk] = await once(child.stdout, 'data');
  return { child, port: Number.parseInt(String(chunk).trim(), 10) };
}

describe('runtime lifecycle commands', () => {
  it('treats repeated pnpm start as an idempotent query for the same managed runtime', async () => {
    const fixture = createFixture();
    const daemon = await seedManagedDaemon(fixture);

    const result = runPnpm(fixture, 'start', ['--', '--daemon']);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /already running|已运行/i);
    assert.equal(processExists(daemon.pid), true, 'the original managed daemon must remain alive');
    assert.equal(existsSync(fixture.marker), false, 'the launcher must not run again');
  });

  it('treats a token-bound legacy v1 daemon as already running across caller timezone and locale', async () => {
    const fixture = createFixture();
    const daemon = await seedManagedDaemon(fixture, { legacyTimezone: 'America/Los_Angeles' });

    const result = runPnpm(fixture, 'start', ['--', '--daemon'], CROSS_TIMEZONE_ENV);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /already running|已运行/i);
    assert.equal(processExists(daemon.pid), true, 'cross-timezone start must preserve the managed daemon');
    assert.equal(existsSync(fixture.marker), false, 'cross-timezone start must remain an idempotent query');
  });

  it('stops the exact token-bound legacy v1 daemon across caller timezone and locale', async () => {
    const fixture = createFixture();
    const daemon = await seedManagedDaemon(fixture, { legacyTimezone: 'America/Los_Angeles' });

    const result = runPnpm(fixture, haltScript, [], CROSS_TIMEZONE_ENV);
    if (result.status === 0 && daemon.exitCode === null && daemon.signalCode === null) await once(daemon, 'exit');

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(processExists(daemon.pid), false, 'the exact legacy daemon must terminate');
  });

  it('restarts the exact token-bound legacy v1 daemon across caller timezone and locale', async () => {
    const fixture = createFixture();
    const daemon = await seedManagedDaemon(fixture, { legacyTimezone: 'America/Los_Angeles' });

    const result = runPnpm(fixture, relaunchScript, ['--', '--daemon'], CROSS_TIMEZONE_ENV);
    if (result.status === 0 && daemon.exitCode === null && daemon.signalCode === null) await once(daemon, 'exit');

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(processExists(daemon.pid), false, 'the exact legacy daemon must terminate before restart');
    assert.equal(readFileSync(fixture.marker, 'utf8'), `${launchPrefix}--daemon\n`);
  });

  it('refuses halt and relaunch for an ambiguous same-second tokenless legacy state', async () => {
    const fixture = createFixture();
    const daemon = await seedManagedDaemon(fixture);
    const paths = daemonStatePaths({
      homeDir: fixture.homeDir,
      projectRoot: fixture.projectRoot,
      deploymentId: 'runtime',
    });
    rewriteAsAmbiguousTokenlessLegacyV1(paths, daemon.pid, 'America/Los_Angeles');

    const haltResult = runPnpm(fixture, haltScript, [], { TZ: 'UTC' });
    assert.notEqual(haltResult.status, 0, `${haltResult.stdout}\n${haltResult.stderr}`);
    assert.match(`${haltResult.stdout}\n${haltResult.stderr}`, /process-identity-mismatch|unsafe/i);
    assert.equal(processExists(daemon.pid), true, 'ambiguous legacy state must not authorize halt');

    const relaunchResult = runPnpm(fixture, relaunchScript, ['--', '--daemon'], { TZ: 'UTC' });
    assert.notEqual(relaunchResult.status, 0, `${relaunchResult.stdout}\n${relaunchResult.stderr}`);
    assert.match(`${relaunchResult.stdout}\n${relaunchResult.stderr}`, /process-identity-mismatch|unsafe/i);
    assert.equal(processExists(daemon.pid), true, 'ambiguous legacy state must not authorize relaunch');
    assert.equal(existsSync(fixture.marker), false, 'relaunch must not follow an ambiguous target');
  });

  it('the explicit relaunch command ends the owned daemon and runs the common entry without flags', async () => {
    const fixture = createFixture();
    const daemon = await seedManagedDaemon(fixture);

    const result = runPnpm(fixture, relaunchScript, ['--', '--daemon']);
    if (daemon.exitCode === null && daemon.signalCode === null) {
      await new Promise((done) => daemon.once('exit', done));
    }

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(processExists(daemon.pid), false, 'the exact recorded daemon must end');
    assert.equal(readFileSync(fixture.marker, 'utf8'), `${launchPrefix}--daemon\n`);
  });

  it('the explicit relaunch command starts normally when the deployment is already down', () => {
    const fixture = createFixture();

    const result = runPnpm(fixture, relaunchScript);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(fixture.marker, 'utf8'), launchPrefix);
  });

  it('the halt command is idempotent when no managed state or live process exists', () => {
    const fixture = createFixture();

    const first = runPnpm(fixture, haltScript);
    const second = runPnpm(fixture, haltScript);

    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(`${second.stdout}\n${second.stderr}`, /not running|未运行|已停止/i);
  });

  it('the halt command refuses an unowned live application port even with the retired variable', async () => {
    const fixture = createFixture();
    const listener = await spawnListener(fixture.projectRoot);
    writeFileSync(join(fixture.projectRoot, '.env'), `FRONTEND_PORT=${listener.port}\n`);

    const result = runPnpm(fixture, haltScript, [], {
      CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
      CAT_CAFE_RUNTIME_RESTART_OK: '1',
    });

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /ownership|归属/i);
    assert.equal(processExists(listener.child.pid), true, 'an unowned listener must remain alive');
  });

  it('the halt command reads local dotenv port overrides before declaring the deployment absent', async () => {
    const fixture = createFixture();
    const listener = await spawnListener(fixture.projectRoot);
    writeFileSync(join(fixture.projectRoot, '.env.local'), `FRONTEND_PORT=${listener.port}\n`);

    const result = runPnpm(fixture, haltScript, [], { CAT_CAFE_RESPECT_DOTENV_PORTS: '1' });

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /ownership|归属/i);
    assert.equal(processExists(listener.child.pid), true, 'the local dotenv listener must remain alive');
  });
});
