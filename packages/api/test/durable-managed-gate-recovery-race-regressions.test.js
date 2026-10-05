import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { initializeDurableManagedGateJob } from '../dist/domains/ball-custody/durable-managed-gate-job.js';
import { parseMacPowerLog } from '../dist/domains/ball-custody/durable-managed-gate-power-evidence.js';
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
    originTaskId: 'hold-race-regression',
    supervisorEpoch: 'race-regression',
    recordPath: join(root, 'managed-gate-jobs', `${jobId}.json`),
    gateReceiptPath: join(root, 'managed-gate-jobs', `${jobId}.gate.json`),
    logPath: join(root, 'managed-gate-jobs', `${jobId}.log`),
    executionSlaMs: 10_000,
    wallSlaMs: 15_000,
    wakeTarget: { threadId: 'thread', catId: 'codex-sol', userId: 'user' },
    recovery: {
      protocolVersion: 2,
      eventLoopGapMs: 100,
      reconciliationBudgetMs: 2_000,
      pollMs: 150,
      powerEvidenceSource: { kind: 'json_file', path: join(root, `${jobId}-power.json`) },
    },
  };
}

function freeze(job) {
  mkdirSync(dirname(job.gateReceiptPath), { recursive: true });
  writeFileSync(
    job.gateReceiptPath,
    JSON.stringify({
      version: 1,
      jobId: job.jobId,
      recovery: { protocolVersion: 2, frozenIdentity: FROZEN_IDENTITY },
    }),
  );
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitFor(path) {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(path), true, `timed out waiting for ${path}`);
}

async function runRaceCase(root, name, kind) {
  const job = recoveryJob(root, name);
  const countPath = join(root, `${name}-count`);
  const releasePath = join(root, `${name}-release`);
  const readyPath = join(root, `${name}-ready`);
  const helperReadyPath = join(root, `${name}-helper-ready`);
  const cancelledPath = join(root, `${name}-cancelled`);
  const launchedPath = join(root, `${name}-launched`);
  const rawRedPath = join(root, `${name}-raw-red`);
  const childPath = join(root, `${name}.mjs`);
  const helperPath = join(root, `${name}-helper.mjs`);
  const cancelRequestPath = `${job.recordPath}.cancel-request`;
  writeFileSync(job.recovery.powerEvidenceSource.path, JSON.stringify({ version: 1, confirmedSleep: [] }));
  writeFileSync(
    helperPath,
    `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {
  if (${JSON.stringify(kind)} === 'cancel-cleanup') {
    writeFileSync(${JSON.stringify(cancelRequestPath)}, JSON.stringify({
      version: 1,
      jobId: ${JSON.stringify(job.jobId)},
      originTaskId: ${JSON.stringify(job.originTaskId)},
      requestedAt: Date.now(),
      cancelledBy: 'race-fixture',
      reason: 'cancel during cleanup',
    }));
    writeFileSync(${JSON.stringify(cancelledPath)}, String(Date.now()));
  }
  setTimeout(() => process.exit(0), 250);
});
writeFileSync(${JSON.stringify(helperReadyPath)}, 'ready');
setTimeout(() => process.exit(0), 6000);
`,
  );
  writeFileSync(
    childPath,
    `import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const countPath = ${JSON.stringify(countPath)};
const releasePath = ${JSON.stringify(releasePath)};
const attempt = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
const receipt = JSON.parse(readFileSync(process.env.CAT_CAFE_MANAGED_JOB_RECORD_PATH, 'utf8'));
writeFileSync(process.env.CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH, JSON.stringify({
  version: 1,
  protocolVersion: 2,
  jobId: process.env.CAT_CAFE_MANAGED_JOB_ID,
  attemptToken: process.env.CAT_CAFE_MANAGED_GATE_ATTEMPT_TOKEN,
  frozenFingerprint: receipt.recovery.frozenIdentity.fingerprint,
}));
writeFileSync(countPath, String(attempt));
if (attempt === 1) {
  const helper = spawn(process.execPath, [${JSON.stringify(helperPath)}], {
    detached: true,
    stdio: ${kind === 'red-open-pipe' ? "'inherit'" : "'ignore'"},
  });
  helper.unref();
  while (!existsSync(${JSON.stringify(helperReadyPath)})) await new Promise((resolve) => setTimeout(resolve, 5));
  writeFileSync(${JSON.stringify(readyPath)}, 'ready');
  while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 5));
  if (${JSON.stringify(kind)} === 'red-open-pipe') writeFileSync(${JSON.stringify(rawRedPath)}, 'assertion failed');
  process.exit(${kind === 'red-open-pipe' ? 1 : 124});
}
`,
  );
  initializeDurableManagedGateJob(job, Date.now());
  freeze(job);
  const runner = new ManagedRunner();
  const command = `echo launched >> ${shellQuote(launchedPath)}; exec ${shellQuote(process.execPath)} ${shellQuote(childPath)}`;
  const { admission, completion } = runner.start(command, {
    managedJob: job,
    timeoutMs: job.wallSlaMs,
    maximumTimeoutMs: job.wallSlaMs,
  });
  assert.equal((await admission).spawned, true);
  await waitFor(readyPath);
  const wakeAt = Date.now();
  writeFileSync(
    job.recovery.powerEvidenceSource.path,
    JSON.stringify({
      version: 1,
      confirmedSleep: [
        {
          evidenceId: `${name}-sleep`,
          startedAt: wakeAt - 1_000,
          endedAt: kind === 'live-heartbeat' ? wakeAt + 100 : wakeAt,
          wakeKind: 'full',
        },
      ],
    }),
  );
  if (kind !== 'live-heartbeat') writeFileSync(releasePath, 'go');
  const result = await completion;
  return {
    result,
    attempts: Number(readFileSync(countPath, 'utf8')),
    spawned: readFileSync(launchedPath, 'utf8').trim().split('\n').length,
    rawRed: existsSync(rawRedPath),
    cancelAdmitted: existsSync(cancelledPath),
    log: readFileSync(job.logPath, 'utf8'),
    snapshot: readDurableGateRecovery(job),
  };
}

describe('durable managed gate recovery race regressions', () => {
  test('a main-process red beats sleep recovery even while inherited pipes remain open', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-pipe-red-'));
    const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    t.after(() => {
      if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
      rmSync(root, { recursive: true, force: true });
    });
    const evidence = await runRaceCase(root, 'red-before-pipe-close', 'red-open-pipe');
    assert.equal(evidence.rawRed, true);
    assert.equal(evidence.attempts, 1);
    assert.notEqual(evidence.result.exitCode, 0);
  });

  test('cancel admitted during cleanup prohibits acknowledgement and successor spawn', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-cleanup-cancel-'));
    const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    t.after(() => {
      if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
      rmSync(root, { recursive: true, force: true });
    });
    const evidence = await runRaceCase(root, 'cancel-during-cleanup', 'cancel-cleanup');
    assert.equal(evidence.cancelAdmitted, true);
    assert.equal(evidence.spawned, 1);
    assert.doesNotMatch(evidence.log, /resumed pauseEpoch/u);
  });

  test('a live attempt killed by reconciliation is not misclassified as a real red', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-live-heartbeat-'));
    const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    t.after(() => {
      if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
      rmSync(root, { recursive: true, force: true });
    });
    const evidence = await runRaceCase(root, 'live-heartbeat', 'live-heartbeat');
    assert.equal(evidence.attempts, 2);
    assert.equal(evidence.result.exitCode, 0);
    assert.match(evidence.log, /resumed pauseEpoch=1/u);
  });

  test('the absolute wall fences acknowledgement after cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-wall-ack-'));
    const job = recoveryJob(root, 'wall-ack');
    job.wallSlaMs = 1_000;
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      freeze(job);
      synchronizeDurableGateFrozenIdentity(job, 1_001);
      const decision = evaluateDurableGateMutation(job, {
        ownerIdentity: OWNER,
        mutation: 'exit',
        rawOutcome: { code: 124, signal: null },
        now: 1_800,
        readPowerEvidence: () => ({
          status: 'available',
          confirmedSleep: [{ evidenceId: 'sleep', startedAt: 1_100, endedAt: 1_700, wakeKind: 'full' }],
        }),
      });
      assert.equal(decision.action, 'self_reconcile');
      assert.equal(acknowledgeDurableGateSelfRecovery(job, OWNER, decision.pauseEpoch, 2_100), false);
      assert.equal(readDurableGateRecovery(job).terminalIntent, 'timed_out');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('DarkWake followed by FullWake authorizes recovery without counting awake time as sleep', () => {
    const parsed = parseMacPowerLog(
      '2026-09-24 04:25:11 -0700 Sleep Entering Sleep state\n' +
        '2026-09-24 04:39:42 -0700 DarkWake DarkWake from Deep Idle\n' +
        '2026-09-24 04:40:00 -0700 Wake DarkWake to FullWake from Deep Idle\n',
    );
    assert.deepEqual(
      parsed.map(({ startedAt, endedAt, wakeKind }) => ({ startedAt, endedAt, wakeKind })),
      [
        {
          startedAt: Date.parse('2026-09-24T04:25:11-07:00'),
          endedAt: Date.parse('2026-09-24T04:39:42-07:00'),
          wakeKind: 'dark',
        },
        {
          startedAt: Date.parse('2026-09-24T04:40:00-07:00'),
          endedAt: Date.parse('2026-09-24T04:40:00-07:00'),
          wakeKind: 'full',
        },
      ],
    );
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-dark-full-'));
    const job = recoveryJob(root, 'dark-full-wake');
    job.wallSlaMs = 2_000_000;
    try {
      const startedAt = parsed[0].startedAt;
      initializeDurableGateRecovery(job, OWNER, startedAt - 1_000);
      freeze(job);
      synchronizeDurableGateFrozenIdentity(job, startedAt - 999);
      assert.deepEqual(
        evaluateDurableGateMutation(job, {
          ownerIdentity: OWNER,
          mutation: 'exit',
          rawOutcome: { code: 124, signal: null },
          now: parsed[1].endedAt + 1,
          readPowerEvidence: () => ({ status: 'available', confirmedSleep: parsed }),
        }),
        {
          action: 'self_reconcile',
          pauseEpoch: 1,
          confirmedSleepMs: 871_000,
          reconcileFrom: startedAt - 1_000,
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
