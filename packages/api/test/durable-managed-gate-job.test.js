import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

describe('F261 durable managed full-gate job', () => {
  test('classifies canonical gate commands and allocates stable persisted identity', async () => {
    const { createDurableManagedGateJob, initializeDurableManagedGateJob, isDurableManagedGateCommand } = await import(
      '../dist/domains/ball-custody/durable-managed-gate-job.js'
    );
    assert.equal(isDurableManagedGateCommand('pnpm gate'), true);
    assert.equal(isDurableManagedGateCommand('bash scripts/pre-merge-check.sh'), true);
    assert.equal(isDurableManagedGateCommand('pnpm test'), false);

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'durable-managed-gate-identity-'));
    try {
      const wakeTarget = { threadId: 'thread-1', catId: 'codex-sol', userId: 'user-1' };
      const descriptor = createDurableManagedGateJob('hold-ball-123', 3_600_000, wakeTarget, tempDir);
      assert.equal(descriptor.kind, 'full_gate');
      assert.equal(descriptor.originTaskId, 'hold-ball-123');
      assert.notEqual(descriptor.jobId, descriptor.originTaskId, 'job identity must not be the ball carrier identity');
      assert.equal(descriptor.executionSlaMs, 3_600_000);
      assert.equal(descriptor.wallSlaMs, 10_800_000);
      assert.equal(descriptor.recordPath, path.join(tempDir, 'managed-gate-jobs', `${descriptor.jobId}.json`));
      assert.equal(
        descriptor.gateReceiptPath,
        path.join(tempDir, 'managed-gate-jobs', `${descriptor.jobId}.gate.json`),
      );
      assert.equal(descriptor.logPath, path.join(tempDir, 'managed-gate-jobs', `${descriptor.jobId}.log`));

      initializeDurableManagedGateJob(descriptor, 1_000);
      const persisted = JSON.parse(readFileSync(descriptor.recordPath, 'utf8'));
      assert.equal(persisted.jobId, descriptor.jobId);
      assert.equal(persisted.originTaskId, 'hold-ball-123');
      assert.equal(persisted.state, 'queued');
      assert.equal(persisted.gateReceiptPath, descriptor.gateReceiptPath);
      assert.equal(persisted.logPath, descriptor.logPath);
      assert.deepEqual(persisted.wakeTarget, wakeTarget);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('adopts a live process, consumes terminal truth, and marks a proven-dead job lost', async () => {
    const { inspectDurableManagedGateJob } = await import('../dist/domains/ball-custody/durable-managed-gate-job.js');
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'durable-managed-gate-'));
    const recordPath = path.join(tempDir, 'job.json');
    const descriptor = {
      kind: 'full_gate',
      jobId: 'job',
      originTaskId: 'hold-ball-job',
      supervisorEpoch: 'epoch-job',
      recordPath,
      gateReceiptPath: path.join(tempDir, 'job.gate.json'),
      logPath: path.join(tempDir, 'job.log'),
      executionSlaMs: 100,
      wallSlaMs: 300,
      wakeTarget: { threadId: 'thread', catId: 'codex-sol', userId: 'user' },
      processIdentity: { pid: 41, ppid: 1, pgid: 41, startedAt: 'birth-41' },
    };
    try {
      assert.equal(
        inspectDurableManagedGateJob(descriptor, { readSnapshot: () => new Map([[41, descriptor.processIdentity]]) })
          .state,
        'adopted',
      );

      writeFileSync(
        recordPath,
        JSON.stringify({
          version: 1,
          jobId: 'job',
          originTaskId: 'hold-ball-job',
          supervisorEpoch: 'epoch-job',
          runId: 'run',
          state: 'terminal',
          terminalStatus: 'green',
          createdAt: 1,
          updatedAt: 10,
        }),
      );
      assert.equal(inspectDurableManagedGateJob(descriptor).state, 'terminal');
      assert.equal(inspectDurableManagedGateJob(descriptor).result.exitCode, 0);

      rmSync(recordPath);
      const lost = inspectDurableManagedGateJob(descriptor, { readSnapshot: () => new Map() });
      assert.equal(lost.state, 'lost');
      assert.equal(lost.result.exitCode, null);
      assert.match(lost.result.tailOutput, /process identity was proven dead/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('persists queued/running/terminal transitions and settles terminal state once', async () => {
    const {
      cancelDurableManagedGateJob,
      createDurableManagedGateJob,
      initializeDurableManagedGateJob,
      inspectDurableManagedGateJob,
      recordDurableManagedGateProcess,
      settleDurableManagedGateJobFromRunner,
    } = await import('../dist/domains/ball-custody/durable-managed-gate-job.js');
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'durable-managed-gate-lifecycle-'));
    const wakeTarget = { threadId: 'thread', catId: 'codex-sol', userId: 'user' };
    try {
      const job = createDurableManagedGateJob('hold-ball-job', 100, wakeTarget, tempDir);
      initializeDurableManagedGateJob(job, 1_000);
      const identity = { pid: 41, ppid: 1, pgid: 41, startedAt: 'birth-41' };
      assert.equal(recordDurableManagedGateProcess(job, identity, 2_000), true);
      assert.equal(JSON.parse(readFileSync(job.recordPath, 'utf8')).state, 'running');
      assert.equal(
        inspectDurableManagedGateJob(job, { now: 2_500, readSnapshot: () => new Map([[41, identity]]) }).state,
        'adopted',
      );

      const failed = { exitCode: 1, timedOut: false, durationMs: 10 };
      assert.equal(settleDurableManagedGateJobFromRunner(job, failed, 3_000), true);
      assert.equal(
        settleDurableManagedGateJobFromRunner(job, { exitCode: 0, timedOut: false, durationMs: 20 }, 4_000),
        false,
      );
      assert.equal(JSON.parse(readFileSync(job.recordPath, 'utf8')).terminalStatus, 'failed');
      assert.equal(
        JSON.parse(readFileSync(`${job.recordPath}.terminal`, 'utf8')).terminalStatus,
        'failed',
        'terminal settlement must have one immutable cross-process receipt',
      );

      const cancelling = createDurableManagedGateJob('hold-ball-cancel', 100, wakeTarget, tempDir);
      initializeDurableManagedGateJob(cancelling, 1_000);
      recordDurableManagedGateProcess(cancelling, identity, 2_000);
      assert.deepEqual(
        cancelDurableManagedGateJob(cancelling, {
          readSnapshot: () => new Map([[41, identity]]),
          killProcess: () => {},
          cancelledBy: 'cat:codex-sol:user',
          reason: 'explicit_hold_cancel',
          now: 2_500,
        }),
        { state: 'pending', admitted: true },
      );
      const cancellingRecord = JSON.parse(readFileSync(cancelling.recordPath, 'utf8'));
      assert.equal(cancellingRecord.state, 'cancelling');
      assert.equal(cancellingRecord.cancel.cancelledBy, 'cat:codex-sol:user');
      const cancelled = inspectDurableManagedGateJob(cancelling, { readSnapshot: () => new Map() });
      assert.equal(cancelled.state, 'terminal');
      assert.equal(cancelled.result.cancelled, true);

      const queuedButSpawned = createDurableManagedGateJob('hold-ball-spawned', 100, wakeTarget, tempDir);
      initializeDurableManagedGateJob(queuedButSpawned, 1_000);
      assert.equal(
        inspectDurableManagedGateJob(
          { ...queuedButSpawned, processIdentity: identity },
          { now: 7_000, queuedOrphanGraceMs: 5_000, readSnapshot: () => new Map([[41, identity]]) },
        ).state,
        'adopted',
      );

      const neverAdmitted = createDurableManagedGateJob('hold-ball-orphan', 100, wakeTarget, tempDir);
      initializeDurableManagedGateJob(neverAdmitted, 1_000);
      assert.equal(
        inspectDurableManagedGateJob(neverAdmitted, { now: 7_000, queuedOrphanGraceMs: 5_000 }).state,
        'lost',
      );

      const missingRecord = createDurableManagedGateJob('hold-ball-missing-record', 100, wakeTarget, tempDir);
      assert.equal(
        inspectDurableManagedGateJob(missingRecord, { now: 7_000, queuedOrphanGraceMs: 5_000 }).state,
        'lost',
        'a registered durable job with no record must terminalize instead of remaining pending forever',
      );

      const expired = createDurableManagedGateJob('hold-ball-wall-timeout', 100, wakeTarget, tempDir);
      initializeDurableManagedGateJob(expired, 1_000);
      recordDurableManagedGateProcess(expired, identity, 2_000);
      const signals = [];
      assert.equal(
        inspectDurableManagedGateJob(expired, {
          now: 1_000 + expired.wallSlaMs + 1,
          readSnapshot: () => new Map([[41, identity]]),
          killProcess: (pid, signal) => signals.push([pid, signal]),
        }).state,
        'pending',
      );
      assert.deepEqual(signals, [[-41, 'SIGTERM']]);
      const expiredTerminal = inspectDurableManagedGateJob(expired, {
        now: 1_000 + expired.wallSlaMs + 2,
        readSnapshot: () => new Map(),
      });
      assert.equal(expiredTerminal.state, 'terminal');
      assert.equal(expiredTerminal.result.timedOut, true);

      const externallySettled = createDurableManagedGateJob('hold-ball-external-terminal', 100, wakeTarget, tempDir);
      initializeDurableManagedGateJob(externallySettled, 1_000);
      recordDurableManagedGateProcess(externallySettled, identity, 2_000);
      writeFileSync(
        externallySettled.gateReceiptPath,
        JSON.stringify({
          version: 1,
          jobId: externallySettled.jobId,
          state: 'terminal',
          terminalStatus: 'green',
          updatedAt: 3_000,
        }),
      );
      const externalTerminal = inspectDurableManagedGateJob(externallySettled, { now: 3_000 });
      assert.equal(externalTerminal.state, 'terminal');
      assert.equal(externalTerminal.result.exitCode, 0);
      assert.equal(JSON.parse(readFileSync(externallySettled.recordPath, 'utf8')).terminalStatus, 'green');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('restart adoption is lease-fenced so one supervisor owns terminal and cancel writes', async () => {
    const {
      createDurableManagedGateJob,
      initializeDurableManagedGateJob,
      inspectDurableManagedGateJob,
      recordDurableManagedGateProcess,
      settleDurableManagedGateJobFromRunner,
    } = await import('../dist/domains/ball-custody/durable-managed-gate-job.js');
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'durable-managed-gate-fence-'));
    const identity = { pid: 41, ppid: 1, pgid: 41, startedAt: 'birth-41' };
    try {
      const original = createDurableManagedGateJob(
        'hold-ball-fenced',
        100,
        { threadId: 'thread', catId: 'codex-sol', userId: 'user' },
        tempDir,
      );
      initializeDurableManagedGateJob(original, 1_000);
      assert.equal(recordDurableManagedGateProcess(original, identity, 2_000), true);

      assert.equal(
        inspectDurableManagedGateJob(original, {
          now: 3_000,
          supervisorEpoch: 'restart-epoch',
          readSnapshot: () => new Map([[41, identity]]),
        }).state,
        'pending',
        'a second API instance cannot adopt before the current durable lease expires',
      );

      assert.equal(
        inspectDurableManagedGateJob(original, {
          now: 70_000,
          supervisorEpoch: 'restart-epoch',
          readSnapshot: () => new Map([[41, identity]]),
        }).state,
        'adopted',
      );
      const adopted = { ...original, supervisorEpoch: 'restart-epoch' };
      const persisted = JSON.parse(readFileSync(original.recordPath, 'utf8'));
      assert.equal(persisted.supervisorEpoch, original.supervisorEpoch);
      assert.equal(recordDurableManagedGateProcess(original, identity, 70_001), false, 'stale epoch must be fenced');
      assert.equal(recordDurableManagedGateProcess(adopted, identity, 70_002), true);
      assert.equal(JSON.parse(readFileSync(original.recordPath, 'utf8')).supervisorEpoch, 'restart-epoch');
      assert.equal(
        settleDurableManagedGateJobFromRunner(original, { exitCode: 0, timedOut: false, durationMs: 1 }, 70_003),
        false,
        'stale supervisor cannot settle terminal truth',
      );
      assert.equal(
        settleDurableManagedGateJobFromRunner(adopted, { exitCode: 0, timedOut: false, durationMs: 1 }, 70_004),
        true,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('persists cancellation intent while the birth fence is unavailable, then a fenced supervisor consumes it', async () => {
    const {
      cancelDurableManagedGateJob,
      createDurableManagedGateJob,
      initializeDurableManagedGateJob,
      inspectDurableManagedGateJob,
      recordDurableManagedGateProcess,
    } = await import('../dist/domains/ball-custody/durable-managed-gate-job.js');
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'durable-managed-gate-cancel-fence-'));
    const identity = { pid: 41, ppid: 1, pgid: 41, startedAt: 'birth-41' };
    try {
      const owner = createDurableManagedGateJob(
        'hold-ball-cancel-fenced',
        100,
        { threadId: 'thread', catId: 'codex-sol', userId: 'user' },
        tempDir,
      );
      initializeDurableManagedGateJob(owner, 1_000);
      assert.equal(recordDurableManagedGateProcess(owner, identity, 2_000), true);
      const requester = { ...owner, supervisorEpoch: 'competing-supervisor' };

      assert.deepEqual(
        cancelDurableManagedGateJob(requester, {
          now: 2_500,
          supervisorEpoch: requester.supervisorEpoch,
          readSnapshot: () => new Map([[41, identity]]),
          killProcess: () => assert.fail('an unfenced supervisor must not signal the worker'),
          cancelledBy: 'operator:test-user',
          reason: 'explicit_hold_cancel',
        }),
        { state: 'pending', admitted: true },
      );
      assert.equal(JSON.parse(readFileSync(owner.recordPath, 'utf8')).state, 'running');
      assert.equal(existsSync(`${owner.recordPath}.terminal`), false);
      assert.equal(
        JSON.parse(readFileSync(`${owner.recordPath}.cancel-request`, 'utf8')).cancelledBy,
        'operator:test-user',
      );

      const signals = [];
      assert.equal(
        inspectDurableManagedGateJob(owner, {
          now: 2_501,
          supervisorEpoch: owner.supervisorEpoch,
          readSnapshot: () => new Map([[41, identity]]),
          killProcess: (pid, signal) => signals.push([pid, signal]),
        }).state,
        'pending',
      );
      assert.deepEqual(signals, [[-41, 'SIGTERM']]);
      assert.equal(JSON.parse(readFileSync(owner.recordPath, 'utf8')).state, 'cancelling');

      const terminal = inspectDurableManagedGateJob(owner, { now: 2_502, readSnapshot: () => new Map() });
      assert.equal(terminal.state, 'terminal');
      assert.equal(terminal.result.cancelled, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('validates the durable record boundary and only cancels an exact process birth identity', async () => {
    const {
      cancelDurableManagedGateJob,
      initializeDurableManagedGateJob,
      recordDurableManagedGateProcess,
      validateDurableManagedGateJob,
    } = await import('../dist/domains/ball-custody/durable-managed-gate-job.js');
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'durable-managed-gate-boundary-'));
    const managedRoot = path.join(dataRoot, 'managed-gate-jobs');
    const descriptor = {
      kind: 'full_gate',
      jobId: 'managed-gate-job',
      originTaskId: 'hold-ball-123',
      supervisorEpoch: 'epoch-job',
      recordPath: path.join(managedRoot, 'managed-gate-job.json'),
      gateReceiptPath: path.join(managedRoot, 'managed-gate-job.gate.json'),
      logPath: path.join(managedRoot, 'managed-gate-job.log'),
      executionSlaMs: 100,
      wallSlaMs: 300,
      wakeTarget: { threadId: 'thread', catId: 'codex-sol', userId: 'user' },
      processIdentity: { pid: 41, ppid: 1, pgid: 41, startedAt: 'birth-41' },
    };
    assert.equal(validateDurableManagedGateJob(descriptor, 'hold-ball-123', dataRoot), true);
    assert.equal(
      validateDurableManagedGateJob(
        { ...descriptor, gateReceiptPath: path.join(managedRoot, '../outside.gate.json') },
        'hold-ball-123',
        dataRoot,
      ),
      false,
    );
    assert.equal(
      validateDurableManagedGateJob(
        { ...descriptor, logPath: path.join(managedRoot, '../outside.log') },
        'hold-ball-123',
        dataRoot,
      ),
      false,
    );
    assert.equal(
      validateDurableManagedGateJob(
        { ...descriptor, recordPath: path.join(managedRoot, '../outside.json') },
        'hold-ball-123',
        dataRoot,
      ),
      false,
    );

    const signalled = [];
    const matchingSnapshot = () => new Map([[41, descriptor.processIdentity]]);
    initializeDurableManagedGateJob(descriptor, 1_000);
    assert.equal(recordDurableManagedGateProcess(descriptor, descriptor.processIdentity, 2_000), true);
    assert.deepEqual(
      cancelDurableManagedGateJob(descriptor, {
        now: 2_500,
        supervisorEpoch: descriptor.supervisorEpoch,
        readSnapshot: matchingSnapshot,
        killProcess: (pid, signal) => signalled.push([pid, signal]),
      }),
      { state: 'pending', admitted: true },
    );
    assert.deepEqual(signalled, [[-41, 'SIGTERM']]);

    const reusedDescriptor = {
      ...descriptor,
      jobId: 'managed-gate-reused-pid',
      originTaskId: 'hold-ball-reused-pid',
      supervisorEpoch: 'epoch-reused-pid',
      recordPath: path.join(managedRoot, 'managed-gate-reused-pid.json'),
      gateReceiptPath: path.join(managedRoot, 'managed-gate-reused-pid.gate.json'),
      logPath: path.join(managedRoot, 'managed-gate-reused-pid.log'),
    };
    initializeDurableManagedGateJob(reusedDescriptor, 1_000);
    assert.equal(recordDurableManagedGateProcess(reusedDescriptor, reusedDescriptor.processIdentity, 2_000), true);
    const reused = cancelDurableManagedGateJob(reusedDescriptor, {
      now: 2_500,
      supervisorEpoch: reusedDescriptor.supervisorEpoch,
      readSnapshot: () => new Map([[41, { ...descriptor.processIdentity, startedAt: 'reused-pid' }]]),
      killProcess: () => assert.fail('PID-reused process must not be signalled'),
    });
    assert.equal(reused.state, 'cancelled');
    assert.equal(reused.result.cancelled, true);
    rmSync(dataRoot, { recursive: true, force: true });
  });
});
