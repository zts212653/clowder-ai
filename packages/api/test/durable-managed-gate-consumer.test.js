import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  createResumableDurableManagedGateJob,
  durableManagedGateConsumerLines,
  isResumableDurableManagedGateCommand,
  projectDurableManagedGateConsumer,
} from '../dist/domains/ball-custody/durable-managed-gate-consumer.js';
import {
  acknowledgeDurableGateSelfRecovery,
  blockDurableGateSelfRecovery,
  evaluateDurableGateMutation,
  initializeDurableGateRecovery,
  synchronizeDurableGateFrozenIdentity,
} from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';

const OWNER = { pid: 41, ppid: 1, pgid: 41, startedAt: 'birth-41' };
const RUN_ID = '11111111-2222-4333-8444-555555555555';
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

function fixture(root, overrides = {}) {
  const created = createResumableDurableManagedGateJob(
    'hold-ball-consumer-test',
    60_000,
    { threadId: 'thread', catId: 'codex-sol', userId: 'user' },
    root,
  );
  return {
    ...created,
    ...overrides,
    recovery: { ...created.recovery, eventLoopGapMs: 100, ...(overrides.recovery ?? {}) },
  };
}

function writeFailedReceipt(job, runId = RUN_ID) {
  writeFileSync(
    job.gateReceiptPath,
    `${JSON.stringify({
      version: 1,
      jobId: job.jobId,
      runId,
      terminalStatus: 'failed',
      recovery: { protocolVersion: 2, frozenIdentity: FROZEN_IDENTITY },
    })}\n`,
  );
}

describe('durable managed gate consumer', () => {
  test('admits exact source-full first/resume commands and preserves scope through recovery', () => {
    const sha = '1'.repeat(40);
    const command = `REDIS_URL=redis://127.0.0.1:6398 pnpm gate --source-full ${sha}`;
    assert.equal(isResumableDurableManagedGateCommand(command), true);
    assert.equal(isResumableDurableManagedGateCommand(`${command} --resume ${RUN_ID}`), true);
    for (const suffix of [
      'main',
      sha.slice(1),
      `${sha} --source-full ${sha}`,
      `${sha} --no-rebase`,
      `${sha} --skip-install`,
    ]) {
      assert.equal(isResumableDurableManagedGateCommand(`pnpm gate --source-full ${suffix}`), false);
    }
    const root = mkdtempSync(path.join(os.tmpdir(), 'source-full-consumer-'));
    const job = fixture(root);
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      const frozenIdentity = { ...FROZEN_IDENTITY, baseSha: sha, verificationScope: 'source_full' };
      writeFileSync(
        job.gateReceiptPath,
        JSON.stringify({
          jobId: job.jobId,
          runId: RUN_ID,
          terminalStatus: 'failed',
          recovery: { protocolVersion: 2, frozenIdentity },
        }),
      );
      assert.deepEqual(synchronizeDurableGateFrozenIdentity(job, 1_001), frozenIdentity);
      const projection = projectDurableManagedGateConsumer(job, command, {
        exitCode: 1,
        cancelled: false,
        timedOut: false,
      });
      assert.equal(projection.resumeCommand, `${command} --resume ${RUN_ID}`);
      assert.equal(
        projectDurableManagedGateConsumer(job, 'pnpm gate', { exitCode: 1, cancelled: false, timedOut: false })
          .resumeCommand,
        null,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('opts in only the canonical v2 command surface and bounded environment prefixes', () => {
    assert.equal(isResumableDurableManagedGateCommand('pnpm gate'), true);
    assert.equal(isResumableDurableManagedGateCommand('pnpm run gate -- --risk contract'), true);
    assert.equal(isResumableDurableManagedGateCommand(`pnpm gate --risk contract -- --resume ${RUN_ID}`), true);
    assert.equal(isResumableDurableManagedGateCommand('REDIS_URL=redis://127.0.0.1:6398 pnpm gate'), true);
    assert.equal(isResumableDurableManagedGateCommand('REDIS_URL=redis://localhost:6398/2 pnpm gate'), true);
    assert.equal(
      isResumableDurableManagedGateCommand(
        'env -u NODE_ENV -u REDIS_URL CAT_CAFE_DATA_DIR=/tmp/cat-cafe-gate pnpm run gate -- --risk contract',
      ),
      true,
    );
    assert.equal(isResumableDurableManagedGateCommand('pnpm\tgate'), true);
    assert.equal(isResumableDurableManagedGateCommand('pnpm gate && echo unsafe'), false);
    assert.equal(isResumableDurableManagedGateCommand('bash scripts/pre-merge-check.sh'), false);
    assert.equal(isResumableDurableManagedGateCommand('env CI=1 pnpm gate'), false);
    assert.equal(isResumableDurableManagedGateCommand('env -u PATH pnpm gate'), false);
    assert.equal(isResumableDurableManagedGateCommand('env --unset=REDIS_URL pnpm gate'), false);
    assert.equal(isResumableDurableManagedGateCommand('env --unset REDIS_URL pnpm gate'), false);
    assert.equal(
      isResumableDurableManagedGateCommand('env REDIS_URL=redis://127.0.0.1:6398 -u NODE_ENV pnpm gate'),
      false,
    );
    assert.equal(isResumableDurableManagedGateCommand('REDIS_URL=redis://127.0.0.1:6399 pnpm gate'), false);
    assert.equal(isResumableDurableManagedGateCommand('CAT_CAFE_DATA_DIR=relative/path pnpm gate'), false);
    assert.equal(isResumableDurableManagedGateCommand('REDIS_URL=$(unsafe) pnpm gate'), false);
    assert.equal(isResumableDurableManagedGateCommand('pnpm\u00a0gate'), false);
    assert.equal(isResumableDurableManagedGateCommand('pnpm\vgate'), false);
    assert.equal(isResumableDurableManagedGateCommand('pnpm\fgate'), false);
    for (const token of ['constructor', 'toString', '__proto__']) {
      assert.equal(isResumableDurableManagedGateCommand(`pnpm gate ${token}`), false);
    }
  });

  test(
    'executes admitted Darwin env prefixes through the same shell command surface',
    { skip: process.platform === 'win32' },
    () => {
      const root = mkdtempSync(`${os.tmpdir()}/durable-gate-command-`);
      const shim = path.join(root, 'pnpm');
      const record = path.join(root, 'observed');
      const shellDollar = '$';
      try {
        writeFileSync(
          shim,
          [
            '#!/bin/sh',
            `printf "%s\\n" "$@" > "${shellDollar}{GATE_SHIM_RECORD}.argv"`,
            `printf "NODE_ENV=%s\\nREDIS_URL=%s\\nCAT_CAFE_DATA_DIR=%s\\n" "${shellDollar}{NODE_ENV-unset}" "${shellDollar}{REDIS_URL-unset}" "${shellDollar}{CAT_CAFE_DATA_DIR-unset}" > "${shellDollar}{GATE_SHIM_RECORD}.env"`,
          ].join('\n'),
        );
        chmodSync(shim, 0o755);
        const command =
          `env -u NODE_ENV REDIS_URL=redis://127.0.0.1:6398 CAT_CAFE_DATA_DIR=${root}/data ` +
          `pnpm gate --resume ${RUN_ID}`;
        assert.equal(isResumableDurableManagedGateCommand(command), true);
        const result = spawnSync(command, {
          shell: '/bin/sh',
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${root}:/usr/bin:/bin`,
            GATE_SHIM_RECORD: record,
            NODE_ENV: 'must-be-unset',
          },
        });
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
        assert.equal(readFileSync(`${record}.argv`, 'utf8'), `gate\n--resume\n${RUN_ID}\n`);
        assert.equal(
          readFileSync(`${record}.env`, 'utf8'),
          `NODE_ENV=unset\nREDIS_URL=redis://127.0.0.1:6398\nCAT_CAFE_DATA_DIR=${root}/data\n`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('publishes one executable continuation for a preserved non-green run', () => {
    const root = mkdtempSync(`${os.tmpdir()}/durable-gate-consumer-`);
    const job = fixture(root);
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      writeFailedReceipt(job);
      const beforeFrozenIdentity = projectDurableManagedGateConsumer(job, 'pnpm gate --risk contract', {
        exitCode: 1,
        timedOut: false,
        durationMs: 249,
      });
      assert.equal(beforeFrozenIdentity.resumeCommand, null);
      assert.deepEqual(durableManagedGateConsumerLines(beforeFrozenIdentity), [
        '恢复状态：不可用（未找到完整的持久恢复身份；不提供续办入口）',
      ]);
      assert.deepEqual(synchronizeDurableGateFrozenIdentity(job, 1_001), FROZEN_IDENTITY);
      const projection = projectDurableManagedGateConsumer(job, 'pnpm gate --risk contract', {
        exitCode: 1,
        timedOut: false,
        durationMs: 250,
      });
      assert.deepEqual(projection, {
        pauseEpoch: 0,
        resumeCount: 0,
        recoveryState: 'running',
        blockReason: null,
        resumeCommand: `pnpm gate --risk contract --resume ${RUN_ID}`,
      });
      assert.deepEqual(durableManagedGateConsumerLines(projection), [
        `可执行续办入口：\`pnpm gate --risk contract --resume ${RUN_ID}\``,
      ]);

      const separated = projectDurableManagedGateConsumer(job, 'pnpm run gate -- --risk contract', {
        exitCode: 1,
        timedOut: false,
        durationMs: 250,
      });
      assert.equal(separated.resumeCommand, `pnpm run gate -- --risk contract --resume ${RUN_ID}`);

      const prefixed = projectDurableManagedGateConsumer(
        job,
        'REDIS_URL=redis://127.0.0.1:6398 pnpm gate -- --risk contract',
        { exitCode: 1, timedOut: false, durationMs: 250 },
      );
      assert.equal(
        prefixed.resumeCommand,
        `REDIS_URL=redis://127.0.0.1:6398 pnpm gate -- --risk contract --resume ${RUN_ID}`,
      );

      const envPrefixed = projectDurableManagedGateConsumer(
        job,
        'env -u NODE_ENV -u REDIS_URL CAT_CAFE_DATA_DIR=/tmp/cat-cafe-gate pnpm gate',
        { exitCode: 1, timedOut: false, durationMs: 250 },
      );
      assert.equal(
        envPrefixed.resumeCommand,
        `env -u NODE_ENV -u REDIS_URL CAT_CAFE_DATA_DIR=/tmp/cat-cafe-gate pnpm gate --resume ${RUN_ID}`,
      );

      const oldRunId = '22222222-3333-4333-8444-666666666666';
      const replaced = projectDurableManagedGateConsumer(job, `pnpm gate --risk contract --resume ${oldRunId}`, {
        exitCode: 1,
        timedOut: false,
        durationMs: 250,
      });
      assert.equal(replaced.resumeCommand, `pnpm gate --risk contract --resume ${RUN_ID}`);
      assert.equal(replaced.resumeCommand.includes(oldRunId), false);

      const nextRunId = '33333333-4444-4444-8555-777777777777';
      writeFailedReceipt(job, nextRunId);
      const repeated = projectDurableManagedGateConsumer(job, replaced.resumeCommand, {
        exitCode: 1,
        timedOut: false,
        durationMs: 500,
      });
      assert.equal(repeated.resumeCommand, `pnpm gate --risk contract --resume ${nextRunId}`);
      assert.equal(repeated.resumeCommand.includes(RUN_ID), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('shows a durable cleanup block without offering an unsafe continuation', () => {
    const root = mkdtempSync(`${os.tmpdir()}/durable-gate-consumer-blocked-`);
    const job = fixture(root);
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      writeFailedReceipt(job);
      assert.deepEqual(synchronizeDurableGateFrozenIdentity(job, 1_001), FROZEN_IDENTITY);
      assert.deepEqual(
        evaluateDurableGateMutation(job, {
          ownerIdentity: OWNER,
          mutation: 'exit',
          rawOutcome: { exitCode: 124 },
          now: 2_000,
          readPowerEvidence: () => ({
            status: 'available',
            confirmedSleep: [{ evidenceId: 'sleep-1', startedAt: 1_100, endedAt: 1_900, wakeKind: 'full' }],
          }),
        }),
        { action: 'self_reconcile', pauseEpoch: 1, confirmedSleepMs: 800, reconcileFrom: 1_000 },
      );
      const reconciling = projectDurableManagedGateConsumer(job, 'pnpm gate', {
        exitCode: 70,
        timedOut: false,
        durationMs: 1_000,
      });
      assert.equal(durableManagedGateConsumerLines(reconciling)[0], '睡眠恢复：正在清理旧执行并对账，尚未启动继任执行');
      assert.equal(blockDurableGateSelfRecovery(job, OWNER, 1, 'cleanup_unproven', 2_010), true);
      const projection = projectDurableManagedGateConsumer(job, 'pnpm gate', {
        exitCode: 70,
        timedOut: false,
        durationMs: 1_010,
      });
      assert.equal(projection.recoveryState, 'blocked');
      assert.equal(projection.blockReason, 'cleanup_unproven');
      assert.equal(projection.resumeCommand, null);
      assert.deepEqual(durableManagedGateConsumerLines(projection), [
        '睡眠恢复：恢复已阻塞，未启动继任执行',
        '恢复状态：已阻塞（cleanup_unproven：旧执行清理未获证明）',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('offers a new explicit job for an immutable hard-wall checkpoint', () => {
    const root = mkdtempSync(`${os.tmpdir()}/durable-gate-consumer-timeout-`);
    const job = fixture(root, { wallSlaMs: 25 });
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      writeFileSync(
        job.gateReceiptPath,
        `${JSON.stringify({
          version: 1,
          jobId: job.jobId,
          runId: RUN_ID,
          terminalStatus: 'timed_out',
          recovery: { protocolVersion: 2, frozenIdentity: FROZEN_IDENTITY },
        })}\n`,
      );
      synchronizeDurableGateFrozenIdentity(job, 1_001);
      assert.deepEqual(
        evaluateDurableGateMutation(job, {
          ownerIdentity: OWNER,
          mutation: 'heartbeat',
          now: 1_026,
          readPowerEvidence: () => ({ status: 'unavailable', reason: 'offline' }),
        }),
        { action: 'terminal_intent', pauseEpoch: 0, intent: 'timed_out' },
      );
      const timedOut = projectDurableManagedGateConsumer(job, 'pnpm gate', {
        exitCode: 124,
        timedOut: true,
        durationMs: 60_000,
      });
      assert.equal(timedOut.resumeCommand, `pnpm gate --resume ${RUN_ID}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('counts only an acknowledged recovery as a started continuation', () => {
    const root = mkdtempSync(`${os.tmpdir()}/durable-gate-consumer-resumed-`);
    const job = fixture(root);
    try {
      initializeDurableGateRecovery(job, OWNER, 1_000);
      writeFailedReceipt(job);
      synchronizeDurableGateFrozenIdentity(job, 1_001);
      assert.deepEqual(
        evaluateDurableGateMutation(job, {
          ownerIdentity: OWNER,
          mutation: 'exit',
          rawOutcome: { exitCode: 124 },
          now: 2_000,
          readPowerEvidence: () => ({
            status: 'available',
            confirmedSleep: [{ evidenceId: 'sleep-2', startedAt: 1_100, endedAt: 1_900, wakeKind: 'full' }],
          }),
        }),
        { action: 'self_reconcile', pauseEpoch: 1, confirmedSleepMs: 800, reconcileFrom: 1_000 },
      );
      assert.equal(acknowledgeDurableGateSelfRecovery(job, OWNER, 1, 2_010), true);
      const resumed = projectDurableManagedGateConsumer(job, 'pnpm gate', {
        exitCode: 1,
        timedOut: false,
        durationMs: 1_010,
      });
      assert.equal(resumed.resumeCount, 1);
      assert.equal(durableManagedGateConsumerLines(resumed)[0], '睡眠恢复：已开始续跑 1 次（冻结输入保持不变）');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
