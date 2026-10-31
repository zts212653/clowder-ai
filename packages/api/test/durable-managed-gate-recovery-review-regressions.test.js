import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { initializeDurableManagedGateJob } from '../dist/domains/ball-custody/durable-managed-gate-job.js';
import {
  parseMacPowerLog,
  readDurableGatePowerEvidence,
} from '../dist/domains/ball-custody/durable-managed-gate-power-evidence.js';
import {
  acknowledgeDurableGateSelfRecovery,
  evaluateDurableGateMutation,
  initializeDurableGateRecovery,
  readDurableGateRecovery,
  synchronizeDurableGateFrozenIdentity,
} from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';
import { ManagedRunner } from '../dist/infrastructure/managed-runner.js';

const OWNER = { pid: 41, ppid: 1, pgid: 41, startedAt: 'birth-41' };
const FROZEN_IDENTITY = {
  headSha: '1'.repeat(40),
  treeSha: '2'.repeat(40),
  baseSha: '3'.repeat(40),
  route: 'full',
  risk: 'contract',
  mode: 'full',
  fingerprint: '4'.repeat(64),
  runnerFingerprint: '5'.repeat(64),
  toolchainFingerprint: '6'.repeat(64),
};

function recoveryJob(root, jobId) {
  return {
    kind: 'resumable_full_gate_v2',
    jobId,
    originTaskId: 'hold-review-regression',
    supervisorEpoch: 'review-regression',
    recordPath: join(root, 'managed-gate-jobs', `${jobId}.json`),
    gateReceiptPath: join(root, 'managed-gate-jobs', `${jobId}.gate.json`),
    logPath: join(root, 'managed-gate-jobs', `${jobId}.log`),
    executionSlaMs: 10_000,
    wallSlaMs: 30_000,
    wakeTarget: { threadId: 'thread', catId: 'codex-sol', userId: 'user' },
    recovery: {
      protocolVersion: 2,
      eventLoopGapMs: 100,
      reconciliationBudgetMs: 500,
      pollMs: 10,
      powerEvidenceSource: { kind: 'json_file', path: join(root, `${jobId}-power.json`) },
    },
  };
}

function freeze(job) {
  mkdirSync(dirname(job.gateReceiptPath), { recursive: true });
  writeFileSync(
    job.gateReceiptPath,
    `${JSON.stringify({
      version: 1,
      jobId: job.jobId,
      recovery: { protocolVersion: 2, frozenIdentity: FROZEN_IDENTITY },
    })}\n`,
  );
}

function fullWakeEvidence(id, start, end) {
  return {
    status: 'available',
    confirmedSleep: [{ evidenceId: id, startedAt: start, endedAt: end, wakeKind: 'full' }],
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(path, timeoutMs = 2_500) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(path), true, `timed out waiting for ${path}`);
}

async function runWorkerCase(root, name, { firstExit, detached = false, advertiseRecovery = true }) {
  const job = recoveryJob(root, name);
  const attemptsPath = join(root, `${name}-attempts`);
  const releasePath = join(root, `${name}-release`);
  const orphanPath = join(root, `${name}-orphan`);
  const fixturePath = join(root, `${name}.mjs`);
  writeFileSync(job.recovery.powerEvidenceSource.path, `${JSON.stringify({ version: 1, confirmedSleep: [] })}\n`);
  writeFileSync(
    fixturePath,
    `import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const attemptsPath = ${JSON.stringify(attemptsPath)};
const releasePath = ${JSON.stringify(releasePath)};
const orphanPath = ${JSON.stringify(orphanPath)};
const attempt = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, 'utf8')) + 1 : 1;
if (${advertiseRecovery} && process.env.CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH) {
  const receipt = JSON.parse(readFileSync(process.env.CAT_CAFE_MANAGED_JOB_RECORD_PATH, 'utf8'));
  writeFileSync(process.env.CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH, JSON.stringify({
    version: 1,
    protocolVersion: 2,
    jobId: process.env.CAT_CAFE_MANAGED_JOB_ID,
    attemptToken: process.env.CAT_CAFE_MANAGED_GATE_ATTEMPT_TOKEN,
    frozenFingerprint: receipt.recovery.frozenIdentity.fingerprint,
  }));
}
if (attempt === 1 && ${detached}) {
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
  writeFileSync(orphanPath, String(orphan.pid));
  orphan.unref();
}
writeFileSync(attemptsPath, String(attempt));
if (attempt === 1) {
  while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 5));
  process.exit(${firstExit});
}
`,
  );
  initializeDurableManagedGateJob(job, Date.now());
  freeze(job);
  const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  try {
    const runner = new ManagedRunner();
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`;
    const { admission, completion } = runner.start(command, {
      managedJob: job,
      timeoutMs: job.wallSlaMs,
      maximumTimeoutMs: job.wallSlaMs,
    });
    assert.equal((await admission).spawned, true);
    await waitFor(attemptsPath);
    const wakeAt = Date.now();
    writeFileSync(
      job.recovery.powerEvidenceSource.path,
      `${JSON.stringify({
        version: 1,
        confirmedSleep: [
          { evidenceId: `${name}-sleep`, startedAt: wakeAt - 1_000, endedAt: wakeAt + 100, wakeKind: 'full' },
        ],
      })}\n`,
    );
    writeFileSync(releasePath, 'release');
    const result = await completion;
    const orphanPid = existsSync(orphanPath) ? Number(readFileSync(orphanPath, 'utf8')) : null;
    return {
      result,
      attempts: Number(readFileSync(attemptsPath, 'utf8')),
      orphanPid,
      orphanAlive: orphanPid !== null && processAlive(orphanPid),
      log: readFileSync(job.logPath, 'utf8'),
    };
  } finally {
    if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
  }
}

describe('durable managed gate recovery review regressions', () => {
  test('the first terminal intent fences every later mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-terminal-'));
    const job = recoveryJob(root, 'terminal-sticky');
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      freeze(job);
      synchronizeDurableGateFrozenIdentity(job, 1_001);
      assert.equal(
        evaluateDurableGateMutation(job, { ownerIdentity: OWNER, mutation: 'cancel', now: 1_010 }).action,
        'terminal_intent',
      );
      const later = evaluateDurableGateMutation(job, {
        ownerIdentity: OWNER,
        mutation: 'heartbeat',
        now: 1_011,
        readPowerEvidence: () => ({ status: 'available', confirmedSleep: [] }),
      });
      assert.deepEqual(later, { action: 'terminal_intent', pauseEpoch: 0, intent: 'cancelled' });
      assert.deepEqual(
        evaluateDurableGateMutation(job, {
          ownerIdentity: OWNER,
          mutation: 'exit',
          rawOutcome: { code: 0, signal: null },
          now: 1_012,
        }),
        { action: 'terminal_intent', pauseEpoch: 0, intent: 'cancelled' },
      );
      assert.equal(acknowledgeDurableGateSelfRecovery(job, OWNER, 0, 1_013), false);
      assert.equal(readDurableGateRecovery(job).state, 'terminal_intent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('only a full wake can authorize self recovery and Wake Requests is not a wake event', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-power-'));
    const job = recoveryJob(root, 'power-events');
    const start = Date.parse('2026-09-24T04:25:11-07:00');
    const dark = Date.parse('2026-09-24T04:39:42-07:00');
    try {
      const darkOnly = parseMacPowerLog(
        '2026-09-24 04:25:11 -0700 Sleep Entering Sleep state\n2026-09-24 04:39:42 -0700 DarkWake DarkWake from Deep Idle\n',
      );
      assert.equal(darkOnly[0].wakeKind, 'dark');
      initializeDurableGateRecovery(job, OWNER, start - 1_000);
      freeze(job);
      synchronizeDurableGateFrozenIdentity(job, start - 999);
      const decision = evaluateDurableGateMutation(job, {
        ownerIdentity: OWNER,
        mutation: 'exit',
        rawOutcome: { code: 124, signal: null },
        now: dark + 1,
        readPowerEvidence: () => ({ status: 'available', confirmedSleep: darkOnly }),
      });
      assert.notEqual(decision.action, 'self_reconcile');

      const requests = parseMacPowerLog(
        '2026-09-24 04:25:11 -0700 Sleep Entering Sleep state\n2026-09-24 04:25:12 -0700 Wake Requests [process=powerd request=Maintenance]\n2026-09-24 04:55:02 -0700 Wake Wake from Deep Idle\n',
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0].endedAt, Date.parse('2026-09-24T04:55:02-07:00'));
      assert.equal(requests[0].wakeKind, 'full');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unclassified nonzero outcomes become blocked instead of green after sleep', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-red-'));
    const job = recoveryJob(root, 'assertion-red');
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      freeze(job);
      synchronizeDurableGateFrozenIdentity(job, 1_001);
      const decision = evaluateDurableGateMutation(job, {
        ownerIdentity: OWNER,
        mutation: 'exit',
        rawOutcome: { code: 1, signal: null },
        now: 2_000,
        readPowerEvidence: () => fullWakeEvidence('sleep', 1_100, 1_900),
      });
      assert.deepEqual(decision, { action: 'blocked', pauseEpoch: 0, reason: 'ambiguous_result' });
      assert.equal(readDurableGateRecovery(job).state, 'blocked');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('power evidence is read outside the SQLite write transaction', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-lock-'));
    const job = recoveryJob(root, 'outside-transaction');
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      freeze(job);
      synchronizeDurableGateFrozenIdentity(job, 1_001);
      const decision = evaluateDurableGateMutation(job, {
        ownerIdentity: OWNER,
        mutation: 'heartbeat',
        now: 2_000,
        readPowerEvidence: () => {
          const contender = new Database(join(dirname(job.recordPath), 'recovery.sqlite'));
          contender.pragma('busy_timeout = 25');
          try {
            contender.exec('BEGIN IMMEDIATE');
            contender.exec('ROLLBACK');
          } finally {
            contender.close();
          }
          return { status: 'unavailable', reason: 'test evidence unavailable' };
        },
      });
      assert.equal(decision.action, 'wait');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the macOS evidence command has a hard time limit and timeout stays unavailable', () => {
    let observedOptions;
    const evidence = readDurableGatePowerEvidence(
      { kind: 'mac_pmset' },
      { from: 1, to: 2, timeoutMs: 37 },
      {
        platform: 'darwin',
        execFileSync: (_file, _args, options) => {
          observedOptions = options;
          const error = new Error('timed out');
          error.code = 'ETIMEDOUT';
          throw error;
        },
      },
    );
    assert.equal(observedOptions.timeout, 37);
    assert.equal(evidence.status, 'unavailable');
    readDurableGatePowerEvidence(
      { kind: 'mac_pmset' },
      { from: 1, to: 2, timeoutMs: Number.MAX_SAFE_INTEGER },
      {
        platform: 'darwin',
        execFileSync: (_file, _args, options) => {
          observedOptions = options;
          return '';
        },
      },
    );
    assert.equal(observedOptions.timeout, 5_000, 'callers cannot widen the OS evidence deadline');
  });

  test('a real worker preserves an assertion failure that overlaps sleep', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-worker-regressions-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const red = await runWorkerCase(root, 'assertion-red-worker', { firstExit: 1, detached: true });
    t.after(() => {
      if (red.orphanPid && processAlive(red.orphanPid)) process.kill(red.orphanPid, 'SIGKILL');
    });
    assert.equal(red.result.exitCode, 1);
    assert.equal(red.attempts, 1);
    assert.equal(red.orphanAlive, false, 'preserving red must still clean its owned descendants');
  });

  test('a real worker proves detached descendant cleanup before spawning a successor', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-detached-regression-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const detached = await runWorkerCase(root, 'detached-worker', { firstExit: 124, detached: true });
    t.after(() => {
      if (detached.orphanPid && processAlive(detached.orphanPid)) process.kill(detached.orphanPid, 'SIGKILL');
    });
    assert.equal(detached.result.exitCode, 0, `${detached.log}\n${detached.result.tailOutput}`);
    assert.equal(detached.attempts, 2);
    assert.equal(detached.orphanAlive, false, 'a successor cannot start while an owned detached descendant lives');
  });

  test('a real worker rejects automatic restart without a frozen-resume child handshake', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-unready-regression-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const unsupported = await runWorkerCase(root, 'unready-worker', { firstExit: 124, advertiseRecovery: false });
    assert.notEqual(unsupported.result.exitCode, 0);
    assert.equal(unsupported.attempts, 1, 'a child without the frozen-resume handshake cannot be restarted');
  });
});
