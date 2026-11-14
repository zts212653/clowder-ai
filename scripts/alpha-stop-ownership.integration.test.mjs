import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIsolatedAlphaE2EFixture } from './lib/alpha-stop-ownership-e2e-fixture.mjs';
import { daemonStatePaths } from './lib/daemon-state.mjs';
import { waitForPort } from './lib/preview-process-runtime.mjs';

function directChildPids(pid) {
  const children = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  if (typeof children.stdout !== 'string') return [];
  return children.stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((childPid) => Number.isInteger(childPid) && childPid > 0);
}

function killDaemonAndChildren(rootPid) {
  const rootCheck = spawnSync('ps', ['-ww', '-p', String(rootPid), '-o', 'command='], { encoding: 'utf8' });
  if (rootCheck.status !== 0 || !String(rootCheck.stdout).includes('start-dev.sh')) return;
  const toKill = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    toKill.push(current);
    queue.push(...directChildPids(current));
  }
  for (const pid of toKill.reverse()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function runStartInCallerProcessGroup({ mainDir, alphaDir, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'perl',
      [
        '-MPOSIX=setpgid',
        '-e',
        'defined POSIX::setpgid(0, 0) or die $!; exec @ARGV or die $!',
        '/bin/bash',
        join(mainDir, 'scripts/alpha-worktree.sh'),
        'start',
        '--dir',
        alphaDir,
        '--no-sync',
        '--no-install',
      ],
      { cwd: mainDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, callerPgid: child.pid }));
  });
}

test('end-to-end non-interactive Alpha start establishes daemon ownership, stop retires stale preview record separately, foreign process stays untouched, and restart succeeds', async (t) => {
  const {
    root,
    mainDir,
    alphaDir,
    stateDir,
    binDir,
    apiPort,
    previewGatewayPort,
    servicePort,
    redisPort,
    previewId,
    completionPath,
    completionBytes,
    historicalPredecessorPath,
    historicalPredecessorBytes,
    virtualPort3011PreloadUrl,
    unsupportedNodeVersion,
    barrierMarkerPath,
  } = await createIsolatedAlphaE2EFixture(t);

  const baseEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${virtualPort3011PreloadUrl}`].filter(Boolean).join(' '),
    HOME: root,
    CAT_CAFE_NODE_BIN: process.execPath,
    CAT_CAFE_NODE_PINNED_MAJOR: process.versions.node.split('.')[0],
    CAT_CAFE_PREVIEW_PROCESS_DIR: stateDir,
    CAT_CAFE_ALPHA_FRONTEND_PORT: '3011',
    CAT_CAFE_ALPHA_API_PORT: String(apiPort),
    CAT_CAFE_ALPHA_PREVIEW_GATEWAY_PORT: String(previewGatewayPort),
    ALPHA_COLLECTIVE_SERVICE_PORT: String(servicePort),
    CAT_CAFE_ALPHA_REDIS_PORT: String(redisPort),
  };
  delete baseEnv.CAT_CAFE_DEPLOYMENT_ID;
  delete baseEnv.CAT_CAFE_RUNTIME_ROOT;

  const runAlphaCmd = (subcommand, extra = []) =>
    spawnSync('bash', [join(mainDir, 'scripts/alpha-worktree.sh'), subcommand, '--dir', alphaDir, ...extra], {
      cwd: mainDir,
      encoding: 'utf8',
      timeout: 15000,
      env: baseEnv,
    });

  // 1. Non-interactive start establishes daemon-state in its own process group and survives caller PGID SIGHUP.
  const started = await runStartInCallerProcessGroup({ mainDir, alphaDir, env: baseEnv });
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const daemonJsonPath = daemonStatePaths({ homeDir: root, projectRoot: alphaDir, deploymentId: 'alpha' }).stateFile;
  assert.equal(existsSync(daemonJsonPath), true, 'non-interactive alpha:start must write daemon.json');
  const daemonPid = JSON.parse(readFileSync(daemonJsonPath, 'utf8')).pid;
  t.after(() => killDaemonAndChildren(daemonPid));
  assert.equal(await waitForPort(apiPort, true, 5000), true, 'owned Alpha daemon API must start listening');
  try {
    process.kill(-started.callerPgid, 'SIGHUP');
  } catch (err) {
    if (err?.code !== 'ESRCH') throw err;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    await waitForPort(apiPort, true, 500),
    true,
    'owned Alpha daemon API must survive caller foreground process-group SIGHUP on terminal close',
  );
  const psPgid = spawnSync('ps', ['-p', String(daemonPid), '-o', 'pgid='], { encoding: 'utf8' });
  assert.equal(psPgid.status, 0);
  assert.equal(Number(psPgid.stdout.trim()), daemonPid, 'daemon child must lead its own background process group');
  assert.equal(existsSync(barrierMarkerPath), true, 'node shim must observe daemon.json before returning unsupported');
  const escapedUnsupportedVersion = unsupportedNodeVersion.replaceAll('.', '\\.');
  assert.match(
    readFileSync(join(alphaDir, '.daemon.log'), 'utf8'),
    new RegExp(
      `\\[node-runtime\\] current Node ${escapedUnsupportedVersion} is unsupported for Clowder AI startup; re-exec with`,
    ),
    'daemon child must deterministically traverse node-runtime-guard re-exec after daemon.json capture',
  );

  // 2. Stop kills live owned daemon AND retires stale preview registration despite older dead historical port-3011 record.
  const stopped = runAlphaCmd('stop');
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  assert.equal(await waitForPort(apiPort, false, 3000), true, 'live owned Alpha API must stop');
  assert.equal(existsSync(daemonJsonPath), false, 'daemon.json must be removed after clean stop');
  assert.equal(existsSync(join(stateDir, `${previewId}.json`)), false, 'stale preview record must be retired');
  assert.equal(readFileSync(completionPath, 'utf8'), completionBytes, 'original completion receipt preserved');
  assert.equal(
    readFileSync(historicalPredecessorPath, 'utf8'),
    historicalPredecessorBytes,
    'older dead historical port-3011 record from another cwd must remain untouched',
  );
  assert.match(stopped.stdout, /registration_retired/);

  // 3. Negative control: foreign unowned listener is reported as error (exit 1) and NEVER killed.
  const foreign = spawn(
    process.execPath,
    ['-e', `require('node:http').createServer((_,r)=>r.end('foreign')).listen(${apiPort},'127.0.0.1')`],
    { stdio: 'ignore' },
  );
  t.after(() => {
    try {
      foreign.kill('SIGKILL');
    } catch {}
  });
  assert.equal(await waitForPort(apiPort, true, 5000), true);
  const refusedStop = runAlphaCmd('stop');
  assert.notEqual(refusedStop.status, 0, 'unowned listener must fail alpha:stop');
  assert.doesNotThrow(() => process.kill(foreign.pid, 0), 'foreign process must never be blind-killed');
  foreign.kill('SIGTERM');
  assert.equal(await waitForPort(apiPort, false, 3000), true);

  // 4. Subsequent non-interactive start and stop succeed cleanly.
  unlinkSync(barrierMarkerPath);
  const restarted = runAlphaCmd('start', ['--no-sync', '--no-install']);
  assert.equal(restarted.status, 0, restarted.stderr || restarted.stdout);
  const restartedDaemonPid = JSON.parse(readFileSync(daemonJsonPath, 'utf8')).pid;
  t.after(() => killDaemonAndChildren(restartedDaemonPid));
  assert.equal(await waitForPort(apiPort, true, 5000), true);
  assert.equal(existsSync(barrierMarkerPath), true, 'second start must also satisfy daemon.json barrier');
  const finalStop = runAlphaCmd('stop');
  assert.equal(finalStop.status, 0, finalStop.stderr || finalStop.stdout);
});
