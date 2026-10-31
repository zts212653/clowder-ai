import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { initializeDurableManagedGateJob } from '../dist/domains/ball-custody/durable-managed-gate-job.js';
import { readDurableGateRecovery } from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';
import { ManagedRunner } from '../dist/infrastructure/managed-runner.js';
import { durableManagedGateOutcomeApartFromCleanup } from '../dist/infrastructure/managed-runner-durable-child.js';

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
    originTaskId: 'hold-settlement-regression',
    supervisorEpoch: 'settlement-regression',
    recordPath: join(root, 'managed-gate-jobs', `${jobId}.json`),
    gateReceiptPath: join(root, 'managed-gate-jobs', `${jobId}.gate.json`),
    logPath: join(root, 'managed-gate-jobs', `${jobId}.log`),
    executionSlaMs: 10_000,
    wallSlaMs: 12_000,
    wakeTarget: { threadId: 'thread', catId: 'codex-sol', userId: 'user' },
    recovery: {
      protocolVersion: 2,
      eventLoopGapMs: 1_000,
      reconciliationBudgetMs: 500,
      pollMs: 100,
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

async function runBoundaryCase(root, name, { power = true, untrackedPipe = false, advertiseRecovery = true } = {}) {
  const job = recoveryJob(root, name);
  const countPath = join(root, `${name}-count`);
  const releasePath = join(root, `${name}-release`);
  const readyPath = join(root, `${name}-ready`);
  const childPath = join(root, `${name}.mjs`);
  writeFileSync(job.recovery.powerEvidenceSource.path, JSON.stringify({ version: 1, confirmedSleep: [] }));
  writeFileSync(
    childPath,
    `import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const countPath = ${JSON.stringify(countPath)};
const releasePath = ${JSON.stringify(releasePath)};
const attempt = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
if (${advertiseRecovery}) {
  const receipt = JSON.parse(readFileSync(process.env.CAT_CAFE_MANAGED_JOB_RECORD_PATH, 'utf8'));
  writeFileSync(process.env.CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH, JSON.stringify({
    version: 1,
    protocolVersion: 2,
    jobId: process.env.CAT_CAFE_MANAGED_JOB_ID,
    attemptToken: process.env.CAT_CAFE_MANAGED_GATE_ATTEMPT_TOKEN,
    frozenFingerprint: receipt.recovery.frozenIdentity.fingerprint,
  }));
}
writeFileSync(countPath, String(attempt));
if (attempt === 1) {
  if (${untrackedPipe}) {
    const helperEnvironment = { ...process.env };
    delete helperEnvironment.CAT_CAFE_MANAGED_GATE_ATTEMPT_TOKEN;
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      detached: true,
      stdio: 'inherit',
      env: helperEnvironment,
    });
    helper.unref();
  }
  writeFileSync(${JSON.stringify(readyPath)}, 'ready');
  while (!existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 5));
  process.exit(0);
}
`,
  );
  initializeDurableManagedGateJob(job, Date.now());
  freeze(job);
  const runner = new ManagedRunner();
  const { admission, completion } = runner.start(`exec ${shellQuote(process.execPath)} ${shellQuote(childPath)}`, {
    managedJob: job,
    timeoutMs: job.wallSlaMs,
    maximumTimeoutMs: job.wallSlaMs,
  });
  assert.equal((await admission).spawned, true);
  await waitFor(readyPath);
  const wakeAt = Date.now();
  if (power) {
    writeFileSync(
      job.recovery.powerEvidenceSource.path,
      JSON.stringify({
        version: 1,
        confirmedSleep: [
          { evidenceId: `${name}-sleep`, startedAt: wakeAt - 1_000, endedAt: wakeAt + 1_000, wakeKind: 'full' },
        ],
      }),
    );
  }
  writeFileSync(releasePath, 'go');
  const result = await completion;
  return {
    result,
    attempts: Number(readFileSync(countPath, 'utf8')),
    afterReleaseMs: Date.now() - wakeAt,
    log: readFileSync(job.logPath, 'utf8'),
    snapshot: readDurableGateRecovery(job),
  };
}

describe('durable managed gate recovery settlement regressions', { concurrency: 1 }, () => {
  test('ordinary green stays final, but a sleep-crossing green reruns the admitted unit', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-late-green-'));
    const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    t.after(() => {
      if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
      rmSync(root, { recursive: true, force: true });
    });
    const normal = await runBoundaryCase(root, 'normal-green', { power: false });
    assert.equal(normal.attempts, 1);
    assert.equal(normal.result.exitCode, 0);

    const late = await runBoundaryCase(root, 'late-green');
    assert.equal(late.attempts, 2);
    assert.equal(late.result.exitCode, 0);
    assert.match(late.log, /resumed pauseEpoch=1/u);
  });

  test('cleanup without process-and-pipe proof fails closed within its budget', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-unproven-cleanup-'));
    const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    t.after(() => {
      if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
      rmSync(root, { recursive: true, force: true });
    });
    const evidence = await runBoundaryCase(root, 'unproven-cleanup', { untrackedPipe: true });
    assert.notEqual(evidence.result.exitCode, 0);
    assert.equal(evidence.snapshot.state, 'blocked');
    assert.ok(evidence.afterReleaseMs < 2_000, `retained handles for ${evidence.afterReleaseMs}ms`);
  });

  test('a sleep-crossing green without the recovery handshake fails closed', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'gate-recovery-unready-green-'));
    const previousDataRoot = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = root;
    t.after(() => {
      if (previousDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = previousDataRoot;
      rmSync(root, { recursive: true, force: true });
    });
    const evidence = await runBoundaryCase(root, 'unready-green', { advertiseRecovery: false });
    assert.equal(evidence.attempts, 1);
    assert.notEqual(evidence.result.exitCode, 0);
  });

  test('only a signal actually sent to the exact managed child is attributable to cleanup', () => {
    for (const signal of ['SIGSEGV', 'SIGUSR2']) {
      const result = { code: null, signal };
      const classified = durableManagedGateOutcomeApartFromCleanup(
        { currentExit: () => ({ result, observedAt: 12_345 }) },
        null,
        false,
      );
      assert.deepEqual(classified, result);
    }
    const cleanupResult = { code: null, signal: 'SIGTERM' };
    const cleanupExit = { result: cleanupResult, observedAt: 12_345 };
    assert.equal(
      durableManagedGateOutcomeApartFromCleanup({ child: { pid: 73 }, currentExit: () => cleanupExit }, null, false, [
        {
          processIdentity: { pid: 73, ppid: 1, pgid: 73, startedAt: 'birth-73' },
          signal: 'SIGTERM',
          sentAt: 12_344,
        },
      ]),
      null,
    );
  });
});
