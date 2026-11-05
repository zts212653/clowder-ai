/**
 * #1838 RED/GREEN on real processes: API A really starts a provider whose PPID chain breaks, A is
 * really killed, Redis really restarts, and a separate API B recovers from the durable store.
 *
 * A and B are independent Node processes using the product modules — the kernel job adoption, the
 * provider-entry link, the RedisTurnExecutionStore and the startup reconciler — in the order the
 * product runs them. B first runs the pre-#1838 recovery (reconciler only) on the same durable state
 * to show the original block, then the fixed recovery. Only this test's own PIDs, private Redis
 * (random port, own password and data directory) and temp directories are touched.
 *
 * Needs Windows and `redis-server`/`redis-cli` on PATH (e.g. the desktop's bundled
 * `.cat-cafe/redis/windows`); otherwise it skips with the reason.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

function findRedisServer() {
  if (process.platform !== 'win32') return null;
  try {
    return execFileSync('where.exe', ['redis-server'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .find((line) => line.trim().endsWith('.exe'))
      ?.trim();
  } catch {
    return null;
  }
}

const redisServer = findRedisServer();
const skip =
  process.platform !== 'win32' ? 'Windows kernel jobs only' : redisServer ? false : 'redis-server is not on PATH';

const HOST_A = `
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const load = (path) => import(new URL(path, config.distUrl).href);
const { adoptWindowsApiJob } = await load('utils/windows-job-owner.js');
const { recordWindowsJobExecutionLink } = await load('utils/windows-job-execution-links.js');
const { RedisTurnExecutionStore } = await load('domains/cats/services/stores/redis/RedisTurnExecutionStore.js');
const { createRedisClient } = await import(config.sharedUrl);
const fail = (error) => { writeFileSync(config.hostAFile, JSON.stringify({ error })); process.exit(3); };
const adoption = await adoptWindowsApiJob({ dataDir: config.dataDir });
if (!adoption.adopted) fail(adoption.reason);
const store = new RedisTurnExecutionStore(createRedisClient({ url: config.redisUrl, keyPrefix: config.prefix }));
const e = config.execution;
const created = await store.createRunning({ invocationId: e.invocationId, parentInvocationId: e.executionId,
  threadId: e.threadId, userId: e.userId, catId: e.catId, executionKind: 'ordinary', startedAt: Date.now(),
  providerLifecycleTracked: true });
if (created.outcome !== 'created') fail('not created: ' + created.outcome);
// The provider-entry order in invoke-single-cat: link to the job, then mark the provider started.
recordWindowsJobExecutionLink({ dataDir: adoption.job.dataDir, jobName: adoption.job.record.jobName, execution: e });
if (!(await store.markProviderStarted(e.invocationId, Date.now()))) fail('provider entry fence rejected');
// Spawned with the product's stdio shape, after adoption, so the tree lands inside the job.
spawn(process.execPath, [config.launcher], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
while (!existsSync(config.treeFile)) await new Promise((resolve) => setTimeout(resolve, 100));
const tree = JSON.parse(readFileSync(config.treeFile, 'utf8'));
writeFileSync(config.hostAFile, JSON.stringify({ host: process.pid, ...tree, jobName: adoption.job.record.jobName }));
setInterval(() => {}, 1000);
`;

const HOST_B = `
import { readFileSync, writeFileSync } from 'node:fs';
const PROCESS_START_AT = Date.now();
const [configPath, mode, outFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const load = (path) => import(new URL(path, config.distUrl).href);
const { adoptWindowsApiJob } = await load('utils/windows-job-owner.js');
const { createCliExecutionOwnerService } = await load('utils/cli-process-ownership.js');
const { RedisTurnExecutionStore } = await load('domains/cats/services/stores/redis/RedisTurnExecutionStore.js');
const { hasUnconfirmedProviderTeardown } = await load('domains/cats/services/stores/ports/TurnExecutionStore.js');
const { TurnExecutionStartupReconciler } = await load('domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js');
const recovery = await load('domains/cats/services/agents/invocation/WindowsJobStopRecovery.js');
const { createRedisClient } = await import(config.sharedUrl);
const fixed = mode === 'fixed';
const adoption = fixed ? await adoptWindowsApiJob({ dataDir: config.dataDir }) : null;
const client = createRedisClient({ url: config.redisUrl, keyPrefix: config.prefix });
const store = new RedisTurnExecutionStore(client);
// The index.ts startup order: owner snapshot, job teardown proof, reconciler, then evidence cleanup.
const live = await createCliExecutionOwnerService({ dataDir: config.dataDir }).listLive();
const pass = fixed ? await recovery.recordVerifiedWindowsJobTeardowns({ store, dataDir: config.dataDir,
  ...(adoption.adopted ? { currentJobName: adoption.job.record.jobName } : {}) }) : null;
const reconciled = live.complete ? await new TurnExecutionStartupReconciler({ store,
  settleEndedTurnResponse: async (turn) => store.clearResponsePending(turn.invocationId) })
  .reconcile({ processStartedAt: PROCESS_START_AT, protectedInvocationIds: live.owners.map((o) => o.invocationId) }) : null;
const cleared = pass ? await recovery.clearSettledWindowsJobEvidence({ store, pass }) : null;
const record = await store.get(config.execution.invocationId);
const running = await store.listRunningByUser(config.execution.userId);
writeFileSync(outFile, JSON.stringify({ pid: process.pid, adopted: adoption?.adopted ?? null, liveComplete: live.complete,
  released: pass?.released ?? [], preserved: pass?.preserved ?? [], interrupted: reconciled?.invocationIds ?? [], cleared,
  status: record?.status, terminalReason: record?.terminalReason ?? null, blocked: hasUnconfirmedProviderTeardown(record),
  runningIds: running.map((r) => r.invocationId) }));
await client.quit();
`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(![6099, 6379, 6397, 6398, 6399, 6401].includes(port), `refusing a shared Redis port ${port}`);
  return port;
}

/** Only our own instance answers our random password, so a PONG proves which server we reach. */
function privateRedis(directory, port, password) {
  const cli = join(dirname(redisServer), 'redis-cli.exe');
  let instance;
  const ping = () => {
    try {
      const args = ['-h', '127.0.0.1', '-p', String(port), '-a', password, 'PING'];
      return (
        execFileSync(cli, args, { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() ===
        'PONG'
      );
    } catch {
      return false;
    }
  };
  return {
    async start() {
      const args = ['--bind', '127.0.0.1', '--port', String(port), '--requirepass', password, '--dir', directory];
      args.push('--appendonly', 'yes', '--appendfsync', 'always', '--save', '', '--daemonize', 'no');
      instance = spawn(redisServer, args, { stdio: 'ignore', windowsHide: true });
      await waitFor(
        () => {
          if (instance.exitCode !== null) throw new Error('private Redis exited before it answered');
          return ping();
        },
        20_000,
        'private Redis to answer',
      );
    },
    async stop() {
      if (!instance || instance.exitCode !== null || instance.signalCode !== null) return;
      const exited = once(instance, 'exit');
      instance.kill();
      await exited;
    },
  };
}

test('a killed Windows API leaves no stuck execution after a real restart', { skip, timeout: 300_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'issue1838-restart-'));
  const dataDir = join(root, 'data');
  const redisDir = join(root, 'redis');
  mkdirSync(dataDir);
  mkdirSync(redisDir);
  const password = randomUUID();
  const redisPort = await freePort();
  const redis = privateRedis(redisDir, redisPort, password);
  const config = {
    redisUrl: `redis://:${password}@127.0.0.1:${redisPort}`,
    distUrl: new URL('../dist/', import.meta.url).href,
    sharedUrl: new URL('../../shared/dist/utils/index.js', import.meta.url).href,
    prefix: `issue1838-restart:${randomUUID()}:`,
    dataDir,
    execution: {
      executionId: `parent-${randomUUID()}`,
      invocationId: `child-${randomUUID()}`,
      threadId: 'issue1838-thread',
      catId: 'codex',
      userId: 'issue1838-user',
    },
    launcher: join(root, 'launcher.cjs'),
    treeFile: join(root, 'tree.json'),
    hostAFile: join(root, 'host-a.json'),
  };
  writeFileSync(join(root, 'writer.cjs'), 'setInterval(() => {}, 1000);');
  // The launcher exits right after detaching its writer, so the writer's PPID names a dead process.
  writeFileSync(
    config.launcher,
    [
      "const { spawn } = require('node:child_process');",
      "const path = require('node:path');",
      "const writer = spawn(process.execPath, [path.join(__dirname, 'writer.cjs')], { stdio: 'ignore', detached: true });",
      'writer.unref();',
      `require('node:fs').writeFileSync(${JSON.stringify(config.treeFile)}, JSON.stringify({ launcher: process.pid, writer: writer.pid }));`,
    ].join('\n'),
  );
  writeFileSync(join(root, 'host-a.mjs'), HOST_A);
  writeFileSync(join(root, 'host-b.mjs'), HOST_B);
  const configPath = join(root, 'config.json');
  const runB = (mode) => {
    const out = join(root, `b-${mode}-${randomUUID()}.json`);
    // A timeout here also catches an API that cannot exit by itself after adopting its job.
    execFileSync(process.execPath, [join(root, 'host-b.mjs'), configPath, mode, out], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90_000,
      windowsHide: true,
    });
    return JSON.parse(readFileSync(out, 'utf8'));
  };

  writeFileSync(configPath, JSON.stringify(config));

  let hostA;
  let tree;
  try {
    await redis.start();
    // --- API A: adopts its job, links and starts the execution, spawns the broken-chain tree ---
    hostA = spawn(process.execPath, [join(root, 'host-a.mjs'), configPath], { stdio: 'ignore', windowsHide: true });
    tree = await waitFor(
      () => (existsSync(config.hostAFile) ? JSON.parse(readFileSync(config.hostAFile, 'utf8')) : null),
      60_000,
      'API A to start its provider',
    );
    assert.equal(tree.error, undefined, `API A failed: ${tree.error}`);
    await waitFor(() => !alive(tree.launcher), 15_000, 'the launcher to exit');
    assert.equal(alive(tree.writer), true, 'the writer outlives its launcher with a broken PPID chain');

    // --- while A is alive, a second API must not release its execution ---
    const whileAlive = runB('fixed');
    assert.deepEqual(whileAlive.released, []);
    assert.equal(whileAlive.status, 'running');
    assert.equal(whileAlive.blocked, true);
    assert.ok(whileAlive.preserved.some((entry) => entry.invocationId === config.execution.invocationId));

    // --- API A is killed on its own; the kernel job must reap the disconnected writer ---
    hostA.kill();
    await waitFor(() => !alive(tree.writer), 20_000, 'the job to reap the writer');
    assert.equal(alive(tree.host), false);

    // --- the desktop restarts Redis too; the ledger must come back from disk ---
    await redis.stop();
    await redis.start();

    // RED: the pre-#1838 recovery has no stop proof, so the execution stays blocked forever.
    const baseline = runB('baseline');
    assert.equal(baseline.liveComplete, true);
    assert.deepEqual(baseline.interrupted, []);
    assert.equal(baseline.status, 'running');
    assert.equal(baseline.blocked, true, 'without stop evidence the old recovery leaves the session blocked');
    assert.deepEqual(baseline.runningIds, [config.execution.invocationId]);

    // GREEN: the fixed recovery proves the job closed and the existing owner settles the execution.
    const recovered = runB('fixed');
    assert.equal(recovered.adopted, true, 'API B adopts its own job and still exits by itself');
    assert.deepEqual(recovered.released, [config.execution.invocationId]);
    assert.deepEqual(recovered.interrupted, [config.execution.invocationId]);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.terminalReason, 'process_restart');
    assert.equal(recovered.blocked, false);
    assert.deepEqual(recovered.runningIds, [], 'the original thread/cat is no longer blocked');
    assert.deepEqual(readdirSync(join(dataDir, 'windows-job-execution-links')), []);
    const owners = readdirSync(join(dataDir, 'windows-api-jobs')).map((name) =>
      JSON.parse(readFileSync(join(dataDir, 'windows-api-jobs', name), 'utf8')),
    );
    assert.equal(
      owners.some((owner) => owner.jobName === tree.jobName),
      false,
      "A's evidence is cleared once settled",
    );

    t.diagnostic(JSON.stringify({ whileAlive, baseline, recovered }));
    // Recovery again changes nothing.
    const repeated = runB('fixed');
    assert.deepEqual([repeated.released, repeated.interrupted, repeated.status], [[], [], 'interrupted']);
  } finally {
    if (hostA && hostA.exitCode === null) hostA.kill();
    for (const pid of [tree?.writer, tree?.launcher]) {
      if (pid && alive(pid)) execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
    }
    await redis.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
