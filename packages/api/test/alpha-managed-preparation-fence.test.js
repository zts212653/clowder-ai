import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  evaluateDurableGateMutation,
  initializeDurableGateRecovery,
  readDurableGateRecovery,
  synchronizeDurableGateFrozenIdentity,
} from '../dist/domains/ball-custody/durable-managed-gate-recovery.js';
import {
  alphaRecoveryJournalPath,
  durableGateRecoveryReadyPath,
} from '../dist/domains/ball-custody/durable-managed-gate-recovery-child-contract.js';
import { createDurableManagedGateAttempt } from '../dist/infrastructure/managed-runner-durable-attempt.js';
import { evaluateDurableManagedGateWorkerFence } from '../dist/infrastructure/managed-runner-durable-recovery-fence.js';
import { selfRecoveryOutcome } from '../dist/infrastructure/managed-runner-durable-recovery-outcome.js';
import { readUnixProcessSnapshotSync } from '../dist/utils/cli-process-ownership.js';

async function preparation(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-preparation-fence-'));
  const consumer = {
    kind: 'alpha_revision_v1',
    subscriptionId: 'private-schedule',
    s3JobId: `alpha-browser-${'a'.repeat(64)}`,
    headSha: 'b'.repeat(40),
    baseSha: 'c'.repeat(40),
  };
  const frozen = {
    ...consumer,
    treeSha: 'd'.repeat(40),
    route: 'full',
    risk: null,
    mode: 'full',
    fingerprint: '1'.repeat(64),
    runnerFingerprint: '2'.repeat(64),
    toolchainFingerprint: '3'.repeat(64),
  };
  const job = {
    kind: 'alpha_revision_v1',
    jobId: 'private-preparation',
    consumer,
    recordPath: join(root, 'job.json'),
    gateReceiptPath: join(root, 'gate.json'),
    wallSlaMs: 60_000,
    recovery: { protocolVersion: 2, eventLoopGapMs: 100, reconciliationBudgetMs: 5_000, pollMs: 20 },
  };
  const owner = readUnixProcessSnapshotSync({ pids: [process.pid] }).get(process.pid);
  const startedAt = Date.now() - 1_000;
  initializeDurableGateRecovery(job, owner, startedAt);
  writeFileSync(
    job.gateReceiptPath,
    JSON.stringify({ jobId: job.jobId, recovery: { protocolVersion: 2, frozenIdentity: frozen } }),
  );
  assert.deepEqual(synchronizeDurableGateFrozenIdentity(job), frozen);
  const decision = evaluateDurableGateMutation(job, {
    ownerIdentity: owner,
    mutation: 'heartbeat',
    readPowerEvidence: () => ({
      status: 'available',
      confirmedSleep: [
        {
          evidenceId: 'private-sleep',
          startedAt: startedAt + 100,
          endedAt: startedAt + 700,
          wakeKind: 'full',
        },
      ],
    }),
  });
  assert.equal(decision.action, 'self_reconcile');

  const binding = createDurableManagedGateAttempt(job, null, frozen);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], {
    env: { ...process.env, ...binding.environment },
    stdio: 'ignore',
  });
  let exit = null;
  const closed = once(child, 'close').then(([code, signal]) => {
    exit = { result: { code, signal }, observedAt: Date.now() };
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 8_000);
  t.after(async () => {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    rmSync(root, { recursive: true, force: true });
  });
  await once(child, 'spawn');
  const identity = readUnixProcessSnapshotSync({ pids: [child.pid] }).get(child.pid);
  assert.ok(identity);
  writeFileSync(
    durableGateRecoveryReadyPath(job, binding.attemptToken),
    JSON.stringify({
      version: 1,
      protocolVersion: 2,
      jobId: job.jobId,
      attemptToken: binding.attemptToken,
      frozenFingerprint: frozen.fingerprint,
      consumerKind: consumer.kind,
      subscriptionId: consumer.subscriptionId,
      s3JobId: consumer.s3JobId,
      generation: 1,
      executionPlanFingerprint: frozen.fingerprint,
    }),
  );
  const entries = [
    { type: 'command-start', stage: 'build', observerProtocol: 'confirmed-sleep-v1' },
    {
      type: 'command-spawn',
      pid: identity.pid,
      startedAt: mode === 'replaced' ? `${identity.startedAt}-old` : identity.startedAt,
    },
  ];
  writeFileSync(
    alphaRecoveryJournalPath(job, binding.attemptToken),
    `${entries
      .map((entry) =>
        JSON.stringify({
          version: 1,
          jobId: job.jobId,
          attemptToken: binding.attemptToken,
          unitKey: 'prepare',
          observedAt: Date.now(),
          ...entry,
        }),
      )
      .join('\n')}\n`,
  );
  const captured = [];
  const outcome = await selfRecoveryOutcome(
    {
      job,
      capture: (bytes) => captured.push(bytes.toString()),
      terminationSignal: () => null,
      readFence: () => {
        if (mode === 'wall') evaluateDurableGateMutation(job, { ownerIdentity: owner, mutation: 'wall' });
        const fence = evaluateDurableManagedGateWorkerFence({
          job,
          owner,
          cancelRequested: mode === 'cancel',
          allowCurrentReconciliation: true,
          terminationSignal: null,
        });
        return fence.open ? null : { kind: 'final', result: fence.result };
      },
    },
    owner,
    { child, attemptToken: binding.attemptToken, closed, currentExit: () => exit },
    decision.pauseEpoch,
    decision.reconcileFrom,
    frozen,
    null,
    5_000,
    20,
  );
  assert.ok(outcome, 'a fenced or replaced preparation must not continue');
  assert.equal(outcome.kind, 'final');
  assert.doesNotMatch(captured.join(''), /continuing the same live preparation/);
  const recovery = readDurableGateRecovery(job);
  assert.equal(recovery.resumeCount, 0);
  assert.notEqual(recovery.state, 'running', 'rejected continuation must not acknowledge the owner as running');
  assert.notEqual(child.signalCode, null, 'the owned child must be cleaned before returning');
  return outcome.result;
}

for (const mode of ['cancel', 'wall']) {
  test(`a live preparation obeys the ${mode} fence instead of continuing`, { timeout: 12_000 }, async (t) => {
    const result = await preparation(t, mode);
    assert.deepEqual(result, mode === 'cancel' ? { code: null, signal: 'SIGTERM' } : { code: 124, signal: null });
  });
}

test(
  'a preparation with a different process birth cannot borrow the live-command continuation',
  { timeout: 12_000 },
  async (t) => {
    assert.deepEqual(await preparation(t, 'replaced'), { code: 70, signal: null });
  },
);
