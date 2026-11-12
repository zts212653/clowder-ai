import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIsolatedAlphaE2EFixture } from './lib/alpha-stop-ownership-e2e-fixture.mjs';
import { daemonStatePaths } from './lib/daemon-state.mjs';
import { waitForPort } from './lib/preview-process-runtime.mjs';

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
    virtualPort3011PreloadUrl,
  } = await createIsolatedAlphaE2EFixture(t);

  const baseEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${virtualPort3011PreloadUrl}`].filter(Boolean).join(' '),
    HOME: root,
    CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
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

  // 1. Non-interactive start establishes daemon-state and brings API port up.
  const started = runAlphaCmd('start', ['--no-sync', '--no-install']);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const daemonJsonPath = daemonStatePaths({ homeDir: root, projectRoot: alphaDir, deploymentId: 'alpha' }).stateFile;
  assert.equal(existsSync(daemonJsonPath), true, 'non-interactive alpha:start must write daemon.json');
  const daemonPid = JSON.parse(readFileSync(daemonJsonPath, 'utf8')).pid;
  t.after(() => {
    try {
      process.kill(-daemonPid, 'SIGKILL');
    } catch {}
  });
  assert.equal(await waitForPort(apiPort, true, 5000), true, 'owned Alpha daemon API should listen');

  // 2. Stop kills live owned daemon AND retires stale preview registration without failing alpha:stop.
  const stopped = runAlphaCmd('stop');
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  assert.equal(await waitForPort(apiPort, false, 3000), true, 'live owned Alpha API must stop');
  assert.equal(existsSync(daemonJsonPath), false, 'daemon.json must be removed after clean stop');
  assert.equal(existsSync(join(stateDir, `${previewId}.json`)), false, 'stale preview record must be retired');
  assert.equal(readFileSync(completionPath, 'utf8'), completionBytes, 'original completion receipt preserved');
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
  const restarted = runAlphaCmd('start', ['--no-sync', '--no-install']);
  assert.equal(restarted.status, 0, restarted.stderr || restarted.stdout);
  assert.equal(await waitForPort(apiPort, true, 5000), true);
  const finalStop = runAlphaCmd('stop');
  assert.equal(finalStop.status, 0, finalStop.stderr || finalStop.stdout);
});
