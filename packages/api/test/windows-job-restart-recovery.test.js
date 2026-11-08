/** #1838: native ownership and legacy unknown are isolated scenarios. */

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
import { fileURLToPath } from 'node:url';

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

// API A and API B are separate processes; each lives in its own helper so it reads as a program.
const HOST_A = fileURLToPath(new URL('./helpers/windows-job-restart-host-a.mjs', import.meta.url));
const HOST_B = fileURLToPath(new URL('./helpers/windows-job-restart-host-b.mjs', import.meta.url));

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

async function runRecovery(t, legacy = false) {
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
    prefix: `issue1838-restart:${randomUUID()}:`,
    dataDir,
    legacy,
    providerPidFile: join(root, 'provider-pid.json'),
    scope: { threadId: 'issue1838-thread', catId: 'codex', userId: 'issue1838-user' },
    streamedBody: 'streamed before the API was killed',
    launcher: join(root, 'launcher.cjs'),
    // The provider root spawnCli starts in its host: it starts the launcher and stays running.
    root: join(root, 'provider-root.cjs'),
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
  writeFileSync(
    config.root,
    [
      "const { spawn } = require('node:child_process');",
      `require('node:fs').writeFileSync(${JSON.stringify(config.providerPidFile)}, JSON.stringify(process.pid));`,
      `spawn(process.execPath, [${JSON.stringify(config.launcher)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const configPath = join(root, 'config.json');
  const runB = (mode) => {
    const out = join(root, `b-${mode}-${randomUUID()}.json`);
    // A fresh API must also exit naturally after its recovery and optional next turn.
    execFileSync(process.execPath, [HOST_B, configPath, mode, out], {
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
    // API A starts a real turn and a provider tree whose launcher exits before its writer.
    hostA = spawn(process.execPath, [HOST_A, configPath], { stdio: 'ignore', windowsHide: true });
    tree = await waitFor(
      () => (existsSync(config.hostAFile) ? JSON.parse(readFileSync(config.hostAFile, 'utf8')) : null),
      60_000,
      'API A to start its provider',
    );
    assert.equal(tree.error, undefined, `API A failed: ${tree.error}`);
    await waitFor(() => !alive(tree.launcher), 15_000, 'the launcher to exit');
    assert.equal(alive(tree.writer), true, 'the writer outlives its launcher with a broken PPID chain');

    const childId = tree.execution.invocationId;
    // A's killed turn resumed the native session its first, completed turn left.
    assert.equal(tree.resumed, tree.session.nativeId);
    // A turn still running keeps every object of its lifecycle open.
    const untouched = (result) => {
      assert.deepEqual([result.status, result.teardownUnconfirmed], ['running', true]);
      assert.deepEqual(result.runningIds, [childId]);
      assert.deepEqual([result.parent.status, result.response.status, result.drafts], ['running', 'processing', 1]);
      assert.deepEqual([result.authOk, result.sweptParents, result.settledResponses], [true, 0, 0]);
    };

    // --- while A is alive, a second API must not release its execution ---
    let whileAlive;
    let denied;
    if (!legacy) {
      whileAlive = runB('fixed');
      assert.deepEqual(whileAlive.released, []);
      untouched(whileAlive);
      assert.ok(whileAlive.preserved.some((entry) => entry.invocationId === childId));
      denied = runB('next-while-alive');
      untouched(denied);
      assert.deepEqual(denied.nextTurn.providerCalls, []);
      assert.equal(denied.nextTurn.errors.length, 1);
      assert.ok(denied.nextTurn.errors[0].includes(`invocationId=${childId}`));
      assert.equal(denied.authAfterNextOk, true);
      assert.deepEqual(denied.nextTurn.session, tree.session);
    }

    // Kill only API A: covered mode must reap its writer; legacy remains physically unknown.
    hostA.kill();
    await waitFor(() => !alive(tree.host), 20_000, 'API A to exit');
    if (!legacy) await waitFor(() => !alive(tree.writer), 20_000, 'the job to reap the writer');

    // --- the desktop restarts Redis too; the ledger must come back from disk ---
    await redis.stop();
    await redis.start();

    if (legacy) {
      const recovered = runB('fixed');
      assert.deepEqual(recovered.released, []);
      assert.deepEqual(recovered.interrupted, [childId]);
      assert.deepEqual([recovered.status, recovered.terminalReason], ['interrupted', 'process_restart']);
      assert.equal(recovered.teardownUnconfirmed, true);
      assert.equal(recovered.teardownAt, null);
      assert.deepEqual(recovered.parent, { status: 'failed', error: 'process_restart' });
      assert.deepEqual(recovered.response, {
        status: 'interrupted',
        reason: 'process_restart',
        content: config.streamedBody,
      });
      assert.deepEqual([recovered.drafts, recovered.responsePending, recovered.authOk], [0, [], false]);
      assert.equal(alive(tree.writer), true, 'unknown remains unknown; the Host does not certify or kill this writer');
      const next = runB('next');
      assert.deepEqual(next.nextTurn.errors, []);
      assert.deepEqual(next.nextTurn.providerCalls, [{ resume: tree.session.nativeId }]);
      assert.deepEqual(next.nextTurn.session, tree.session);
      assert.equal(next.teardownAt, null);
      t.diagnostic(JSON.stringify({ scenario: 'legacy-no-link', recovered, next }));
      return;
    }

    // GREEN, with a failing response store: the job proof ends the child, and R stays pending.
    const settleFailed = runB('settle-fail');
    assert.deepEqual(settleFailed.released, [childId]);
    assert.deepEqual(settleFailed.interrupted, [childId]);
    assert.deepEqual([settleFailed.status, settleFailed.terminalReason], ['interrupted', 'process_restart']);
    assert.deepEqual([settleFailed.teardownUnconfirmed, settleFailed.runningIds], [false, []]);
    assert.equal(typeof settleFailed.teardownAt, 'number');
    assert.deepEqual(settleFailed.parent, { status: 'failed', error: 'process_restart' });
    assert.equal(settleFailed.sweptParents, 1);
    assert.deepEqual([settleFailed.settledResponses, settleFailed.settlementFailures], [0, [childId]]);
    assert.deepEqual(
      [settleFailed.response.status, settleFailed.drafts, settleFailed.responsePending],
      ['processing', 1, [childId]],
    );
    assert.equal(settleFailed.authOk, false, "the old child's callback credential no longer verifies");

    // The next start retries the pending R from its draft.
    const recovered = runB('fixed');
    assert.deepEqual([recovered.released, recovered.interrupted, recovered.sweptParents], [[], [], 0]);
    // R keeps the streamed body and says it was interrupted; it does not claim the work finished.
    assert.deepEqual(recovered.response, {
      status: 'interrupted',
      reason: 'process_restart',
      content: config.streamedBody,
    });
    assert.deepEqual([recovered.settledResponses, recovered.drafts, recovered.responsePending], [1, 0, []]);
    assert.deepEqual(readdirSync(join(dataDir, 'windows-job-execution-links')), []);
    const owners = readdirSync(join(dataDir, 'windows-api-jobs')).map((name) =>
      JSON.parse(readFileSync(join(dataDir, 'windows-api-jobs', name), 'utf8')),
    );
    assert.equal(
      owners.some((owner) => owner.jobName === tree.jobName),
      false,
      "A's evidence is cleared once settled",
    );

    t.diagnostic(JSON.stringify({ scenario: 'native', whileAlive, denied, settleFailed, recovered }));
    // Recovery again changes nothing, and the next message of the same thread/role reaches its provider.
    const repeated = runB('next');
    assert.deepEqual([repeated.released, repeated.interrupted, repeated.status], [[], [], 'interrupted']);
    assert.deepEqual(
      [repeated.settledResponses, repeated.sweptParents, repeated.response.status],
      [0, 0, 'interrupted'],
    );
    assert.deepEqual(repeated.runningIds, []);
    // It reaches the provider through invokeSingleCat, resuming the same native and logical session.
    assert.deepEqual(repeated.nextTurn.errors, []);
    assert.deepEqual(repeated.nextTurn.providerCalls, [{ resume: tree.session.nativeId }]);
    assert.deepEqual(repeated.nextTurn.session, tree.session);
    // That turn removes its provider-host link once its stop and terminal are durable.
    assert.deepEqual(readdirSync(join(dataDir, 'windows-job-execution-links')), []);
  } finally {
    if (hostA && hostA.exitCode === null) hostA.kill();
    // Stop only our recorded PIDs; the legacy tree has no Job and needs explicit test cleanup.
    const providerPid = existsSync(config.providerPidFile)
      ? JSON.parse(readFileSync(config.providerPidFile, 'utf8'))
      : undefined;
    for (const pid of [providerPid, tree?.writer, tree?.launcher]) {
      if (pid && alive(pid)) spawn('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
    }
    await redis.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  'a killed Windows API recovers its owned provider and resumes the original session',
  { skip, timeout: 300_000 },
  (t) => runRecovery(t),
);
test('legacy no-link recovery settles the Host while physical stop stays unknown', { skip, timeout: 300_000 }, (t) =>
  runRecovery(t, true),
);
