import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { initializeDurableManagedGateJob } from '../dist/domains/ball-custody/durable-managed-gate-job.js';
import {
  parseMacPowerLog,
  readDurableGatePowerEvidence,
} from '../dist/domains/ball-custody/durable-managed-gate-power-evidence.js';
import {
  acknowledgeDurableGateSelfRecovery,
  DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION,
  evaluateDurableGateMutation,
  initializeDurableGateRecovery,
  readDurableGateRecovery,
  synchronizeDurableGateFrozenIdentity,
} from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';
import { ManagedRunner } from '../dist/infrastructure/managed-runner.js';
import { createDurableManagedGateAttempt } from '../dist/infrastructure/managed-runner-durable-attempt.js';

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

function recoveryJob(root, overrides = {}) {
  const jobId = overrides.jobId ?? 'managed-gate-recovery-test';
  return {
    kind: 'resumable_full_gate_v2',
    jobId,
    originTaskId: 'hold-ball-recovery-test',
    supervisorEpoch: 'recovery-test-epoch',
    recordPath: join(root, 'managed-gate-jobs', `${jobId}.json`),
    gateReceiptPath: join(root, 'managed-gate-jobs', `${jobId}.gate.json`),
    logPath: join(root, 'managed-gate-jobs', `${jobId}.log`),
    executionSlaMs: 10_000,
    wallSlaMs: 100_000,
    wakeTarget: { threadId: 'thread', catId: 'codex-sol', userId: 'user' },
    recovery: {
      protocolVersion: DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION,
      eventLoopGapMs: 100,
      reconciliationBudgetMs: 50,
      pollMs: 10,
      powerEvidenceSource: { kind: 'mac_pmset' },
    },
    ...overrides,
  };
}

function freeze(job) {
  mkdirSync(join(job.gateReceiptPath, '..'), { recursive: true });
  writeFileSync(
    job.gateReceiptPath,
    `${JSON.stringify({
      version: 1,
      jobId: job.jobId,
      recovery: {
        protocolVersion: DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION,
        frozenIdentity: FROZEN_IDENTITY,
      },
    })}\n`,
    { flag: 'w' },
  );
}

describe('durable managed gate recovery fence', () => {
  test('serializes the validated recovery snapshot into the canonical versioned resume identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-gate-recovery-wire-'));
    const job = recoveryJob(root);
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      freeze(job);
      const frozenIdentity = synchronizeDurableGateFrozenIdentity(job, 1_001);
      const attempt = createDurableManagedGateAttempt(job, 1, frozenIdentity, 1_000);
      assert.deepEqual(JSON.parse(attempt.environment.CAT_CAFE_MANAGED_GATE_FROZEN_IDENTITY_JSON), {
        ...FROZEN_IDENTITY,
        protocolVersion: DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION,
      });
      assert.throws(
        () => createDurableManagedGateAttempt(job, 1, { ...frozenIdentity, protocolVersion: 3 }, 1_000),
        /protocol version is unsupported/,
      );

      const futureJob = recoveryJob(root, { jobId: 'managed-gate-recovery-future-wire' });
      initializeDurableGateRecovery(futureJob, OWNER, 2_000);
      writeFileSync(
        futureJob.gateReceiptPath,
        `${JSON.stringify({
          version: 1,
          jobId: futureJob.jobId,
          recovery: {
            protocolVersion: DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION,
            frozenIdentity: { ...FROZEN_IDENTITY, protocolVersion: 3 },
          },
        })}\n`,
      );
      assert.equal(synchronizeDurableGateFrozenIdentity(futureJob, 2_001), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the macOS adapter reads power evidence within its command bounds', () => {
    const from = Date.parse('2026-09-24T04:00:00-07:00');
    const to = Date.parse('2026-09-24T05:00:00-07:00');
    const evidence = readDurableGatePowerEvidence(
      { kind: 'mac_pmset' },
      { from, to },
      {
        platform: 'darwin',
        execFileSync(file, args, options) {
          assert.equal(file, '/usr/bin/pmset');
          assert.deepEqual(args, ['-g', 'log']);
          assert.deepEqual(options, {
            encoding: 'utf8',
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024 * 1024,
            timeout: 5_000,
          });
          return '2026-09-24 04:25:11 -0700 Sleep Entering Sleep state\n2026-09-24 04:39:42 -0700 Wake Wake from Deep Idle\n';
        },
      },
    );
    assert.deepEqual(evidence, {
      status: 'available',
      confirmedSleep: [
        {
          evidenceId: `pmset:${Date.parse('2026-09-24T04:25:11-07:00')}:${Date.parse('2026-09-24T04:39:42-07:00')}:full`,
          startedAt: Date.parse('2026-09-24T04:25:11-07:00'),
          endedAt: Date.parse('2026-09-24T04:39:42-07:00'),
          wakeKind: 'full',
        },
      ],
    });
  });

  test('the macOS adapter reports command timeout as unavailable', () => {
    const evidence = readDurableGatePowerEvidence(
      { kind: 'mac_pmset' },
      { from: 0, to: 1 },
      {
        platform: 'darwin',
        execFileSync() {
          throw new Error('spawnSync /usr/bin/pmset ETIMEDOUT');
        },
      },
    );
    assert.deepEqual(evidence, {
      status: 'unavailable',
      reason: 'spawnSync /usr/bin/pmset ETIMEDOUT',
    });
  });

  test(
    'the production macOS adapter either reads host evidence or reports its timeout',
    { skip: process.platform !== 'darwin' },
    () => {
      const now = Date.now();
      const evidence = readDurableGatePowerEvidence(
        { kind: 'mac_pmset' },
        { from: now - 7 * 24 * 60 * 60_000, to: now },
      );
      if (evidence.status === 'unavailable') {
        assert.match(evidence.reason, /ETIMEDOUT/u);
        return;
      }
      for (const interval of evidence.confirmedSleep) {
        assert.equal(
          interval.startedAt < interval.endedAt ||
            (interval.wakeKind === 'full' && interval.startedAt === interval.endedAt),
          true,
        );
        assert.equal(interval.startedAt < now, true);
        assert.equal(interval.endedAt > now - 7 * 24 * 60 * 60_000, true);
      }
    },
  );

  test('the macOS adapter treats DarkWake as a sleep boundary without calling it a full wake', () => {
    assert.deepEqual(
      parseMacPowerLog(
        `2026-09-24 04:25:11 -0700 Sleep               Entering Sleep state\n2026-09-24 04:39:42 -0700 DarkWake            DarkWake from Deep Idle\n2026-09-24 04:40:27 -0700 Sleep               Entering Maintenance Sleep\n2026-09-24 04:55:02 -0700 Wake                Wake from Deep Idle\n`,
      ),
      [
        {
          evidenceId: `pmset:${Date.parse('2026-09-24T04:25:11-07:00')}:${Date.parse('2026-09-24T04:39:42-07:00')}:dark`,
          startedAt: Date.parse('2026-09-24T04:25:11-07:00'),
          endedAt: Date.parse('2026-09-24T04:39:42-07:00'),
          wakeKind: 'dark',
        },
        {
          evidenceId: `pmset:${Date.parse('2026-09-24T04:40:27-07:00')}:${Date.parse('2026-09-24T04:55:02-07:00')}:full`,
          startedAt: Date.parse('2026-09-24T04:40:27-07:00'),
          endedAt: Date.parse('2026-09-24T04:55:02-07:00'),
          wakeKind: 'full',
        },
      ],
    );
  });

  test('the same live owner fences exit/timeout once, then acknowledges one pause epoch', () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-gate-recovery-live-'));
    const job = recoveryJob(root);
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      freeze(job);
      assert.deepEqual(synchronizeDurableGateFrozenIdentity(job, 1_001), FROZEN_IDENTITY);
      const evidence = () => ({
        status: 'available',
        confirmedSleep: [{ evidenceId: 'sleep-1', startedAt: 1_100, endedAt: 1_900 }],
      });

      assert.deepEqual(
        evaluateDurableGateMutation(job, {
          ownerIdentity: OWNER,
          mutation: 'exit',
          rawOutcome: { exitCode: 124 },
          now: 2_000,
          readPowerEvidence: evidence,
        }),
        { action: 'self_reconcile', pauseEpoch: 1, confirmedSleepMs: 800, reconcileFrom: 1_000 },
      );
      assert.deepEqual(
        evaluateDurableGateMutation(job, {
          ownerIdentity: OWNER,
          mutation: 'timeout',
          now: 2_001,
          readPowerEvidence: evidence,
        }),
        { action: 'wait', pauseEpoch: 1, deadlineAt: 2_050 },
        'a second wake callback must join the same reconciliation instead of incrementing the epoch',
      );
      assert.equal(acknowledgeDurableGateSelfRecovery(job, OWNER, 1, 2_010), true);
      assert.equal(
        acknowledgeDurableGateSelfRecovery(job, { ...OWNER, startedAt: 'reused-pid' }, 1, 2_011),
        false,
        'PID reuse must not inherit the live-owner recovery right',
      );
      assert.deepEqual(readDurableGateRecovery(job), {
        state: 'running',
        pauseEpoch: 1,
        resumeCount: 1,
        ownerIdentity: OWNER,
        lastObservedAt: 2_010,
        reconcileDeadlineAt: null,
        terminalIntent: null,
        blockReason: null,
        frozenIdentity: FROZEN_IDENTITY,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing OS evidence waits only to the durable reconciliation deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-gate-recovery-unknown-'));
    const job = recoveryJob(root, { jobId: 'managed-gate-recovery-unknown' });
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      freeze(job);
      synchronizeDurableGateFrozenIdentity(job, 1_001);
      const unavailable = () => ({ status: 'unavailable', reason: 'pmset unavailable' });
      assert.deepEqual(
        evaluateDurableGateMutation(job, {
          ownerIdentity: OWNER,
          mutation: 'exit',
          now: 2_000,
          readPowerEvidence: unavailable,
        }),
        { action: 'wait', pauseEpoch: 0, deadlineAt: 2_050 },
      );
      assert.deepEqual(
        evaluateDurableGateMutation(job, {
          ownerIdentity: OWNER,
          mutation: 'exit',
          now: 2_051,
          readPowerEvidence: unavailable,
        }),
        { action: 'proceed', pauseEpoch: 0, confirmedSleepMs: 0 },
      );
      assert.equal(readDurableGateRecovery(job).state, 'running');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cancel and absolute wall intent are never delayed by clock reconciliation', () => {
    const root = mkdtempSync(join(tmpdir(), 'managed-gate-recovery-intent-'));
    try {
      const cancelled = recoveryJob(root, { jobId: 'managed-gate-recovery-cancel' });
      initializeDurableGateRecovery(cancelled, OWNER, 1_000);
      assert.deepEqual(
        evaluateDurableGateMutation(cancelled, {
          ownerIdentity: OWNER,
          mutation: 'cancel',
          now: 1_001,
          readPowerEvidence: () => ({ status: 'unavailable', reason: 'offline' }),
        }),
        { action: 'terminal_intent', pauseEpoch: 0, intent: 'cancelled' },
      );

      const expired = recoveryJob(root, { jobId: 'managed-gate-recovery-wall', wallSlaMs: 25 });
      initializeDurableGateRecovery(expired, OWNER, 1_000);
      assert.deepEqual(
        evaluateDurableGateMutation(expired, {
          ownerIdentity: OWNER,
          mutation: 'heartbeat',
          now: 1_026,
          readPowerEvidence: () => ({ status: 'unavailable', reason: 'offline' }),
        }),
        { action: 'terminal_intent', pauseEpoch: 0, intent: 'timed_out' },
      );
      const cancelAtWall = recoveryJob(root, { jobId: 'managed-gate-recovery-cancel-at-wall', wallSlaMs: 25 });
      initializeDurableGateRecovery(cancelAtWall, OWNER, 1_000);
      assert.deepEqual(
        evaluateDurableGateMutation(cancelAtWall, {
          ownerIdentity: OWNER,
          mutation: 'cancel',
          now: 1_026,
        }),
        { action: 'terminal_intent', pauseEpoch: 0, intent: 'timed_out' },
        'the absolute wall remains authoritative when cancel and wall expiry race',
      );
      assert.equal(existsSync(join(root, 'managed-gate-jobs', 'recovery.sqlite')), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the real durable worker keeps its PID while an exit-first wake resumes exactly once', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'managed-gate-recovery-worker-'));
    const powerPath = join(root, 'power.json');
    const attemptsPath = join(root, 'attempts.txt');
    const releasePath = join(root, 'release');
    const movingBasePath = join(root, 'origin-main');
    const resumeEvidencePath = join(root, 'resume-evidence.json');
    const fixturePath = join(root, 'managed-child.mjs');
    const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
    const runner = new ManagedRunner();
    let completion;
    process.env.CAT_CAFE_DATA_DIR = root;
    t.after(async () => {
      runner.cancel();
      await completion;
      if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
      rmSync(root, { recursive: true, force: true });
    });
    writeFileSync(powerPath, `${JSON.stringify({ version: 1, confirmedSleep: [] })}\n`);
    writeFileSync(movingBasePath, FROZEN_IDENTITY.baseSha);
    writeFileSync(
      fixturePath,
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [attemptsPath, releasePath, movingBasePath, resumeEvidencePath] = process.argv.slice(2);
const attempt = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, 'utf8')) + 1 : 1;
if (process.env.CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH) {
  const receipt = JSON.parse(readFileSync(process.env.CAT_CAFE_MANAGED_JOB_RECORD_PATH, 'utf8'));
  writeFileSync(process.env.CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH, JSON.stringify({
    version: 1,
    protocolVersion: 2,
    jobId: process.env.CAT_CAFE_MANAGED_JOB_ID,
    attemptToken: process.env.CAT_CAFE_MANAGED_GATE_ATTEMPT_TOKEN,
    frozenFingerprint: receipt.recovery.frozenIdentity.fingerprint,
  }));
}
writeFileSync(attemptsPath, String(attempt));
if (attempt === 1) {
  while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 5));
  process.exit(124);
}
writeFileSync(resumeEvidencePath, JSON.stringify({
  frozenIdentity: JSON.parse(process.env.CAT_CAFE_MANAGED_GATE_FROZEN_IDENTITY_JSON),
  currentOriginMain: readFileSync(movingBasePath, 'utf8'),
  reconcileFrom: Number(process.env.CAT_CAFE_MANAGED_GATE_RECONCILE_FROM),
}));
console.log('managed child recovered');
`,
    );
    const job = recoveryJob(root, {
      jobId: 'managed-gate-recovery-worker',
      wallSlaMs: 30_000,
      recovery: {
        protocolVersion: 2,
        eventLoopGapMs: 100,
        reconciliationBudgetMs: 500,
        // Keep the worker inside its first exit-vs-poll observation while the
        // fixture publishes wake evidence and releases the child. A 10ms poll
        // let a heartbeat race the fixture and stopped exercising exit-first.
        pollMs: 500,
        powerEvidenceSource: { kind: 'json_file', path: powerPath },
      },
    });
    const startedAt = Date.now();
    initializeDurableManagedGateJob(job, startedAt);
    freeze(job);
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} ${JSON.stringify(attemptsPath)} ${JSON.stringify(releasePath)} ${JSON.stringify(movingBasePath)} ${JSON.stringify(resumeEvidencePath)}`;
    const execution = runner.start(command, {
      managedJob: job,
      timeoutMs: job.wallSlaMs,
      maximumTimeoutMs: job.wallSlaMs,
    });
    completion = execution.completion;
    const admitted = await execution.admission;
    assert.equal(admitted.spawned, true);
    // Startup is fixture preparation, not the recovery timing contract. Share
    // the managed job's absolute deadline and stop promptly if the worker exits.
    let completedResult;
    void completion.then((result) => {
      completedResult = result;
    });
    while (!existsSync(attemptsPath) && !completedResult && Date.now() < startedAt + job.wallSlaMs) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      existsSync(attemptsPath),
      completedResult
        ? `worker exited before readiness: ${JSON.stringify(completedResult)}`
        : 'worker did not become ready within the managed job wall deadline',
    );
    assert.equal(readFileSync(attemptsPath, 'utf8'), '1');
    const wakeAt = Date.now();
    const confirmedSleepStartedAt = wakeAt - 1_000;
    const confirmedSleepEndedAt = wakeAt;
    writeFileSync(
      powerPath,
      `${JSON.stringify({
        version: 1,
        confirmedSleep: [
          {
            evidenceId: 'fixture-sleep-1',
            startedAt: confirmedSleepStartedAt,
            endedAt: confirmedSleepEndedAt,
          },
        ],
      })}\n`,
    );
    writeFileSync(movingBasePath, 'f'.repeat(40));
    writeFileSync(releasePath, 'release');
    const result = await completion;
    assert.equal(result.exitCode, 0, result.tailOutput);
    assert.equal(result.timedOut, false);
    assert.equal(readFileSync(attemptsPath, 'utf8'), '2', 'one wake must produce one successor attempt');
    const resumeEvidence = JSON.parse(readFileSync(resumeEvidencePath, 'utf8'));
    assert.deepEqual(resumeEvidence.frozenIdentity, {
      ...FROZEN_IDENTITY,
      protocolVersion: DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION,
    });
    assert.equal(resumeEvidence.currentOriginMain, 'f'.repeat(40));
    assert.equal(Number.isSafeInteger(resumeEvidence.reconcileFrom), true);
    assert.ok(
      resumeEvidence.reconcileFrom >= confirmedSleepStartedAt && resumeEvidence.reconcileFrom < confirmedSleepEndedAt,
      `reconciliation boundary ${resumeEvidence.reconcileFrom} must remain inside the consumed sleep interval`,
    );
    const record = JSON.parse(readFileSync(job.recordPath, 'utf8'));
    assert.equal(record.ownerIdentity.pid, admitted.pid, 'the original live durable worker remains the owner');
    assert.equal(readDurableGateRecovery(job).pauseEpoch, 1);
    assert.match(readFileSync(job.logPath, 'utf8'), /resumed pauseEpoch=1/);
    assert.match(readFileSync(job.logPath, 'utf8'), /managed child recovered/);
  });
});
