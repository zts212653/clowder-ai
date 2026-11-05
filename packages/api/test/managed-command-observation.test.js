import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDurableManagedGateJob } from '../dist/domains/managed-job/durable-managed-gate-job.js';
import {
  rawDurableGateRecord,
  recordDurableManagedGateProcess,
  writeDurableGateRecord,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { claimDurableGateSupervisor } from '../dist/domains/managed-job/durable-managed-gate-supervisor.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { runManagedCommandWorker } from '../dist/infrastructure/managed-runner-command-worker.js';
import { cleanupAndDrainDurableManagedGateAttempt } from '../dist/infrastructure/managed-runner-durable-child.js';
import { buildManagedRunnerEnvironment } from '../dist/infrastructure/managed-runner-environment.js';
import { readUnixProcessSnapshotSync } from '../dist/utils/cli-process-ownership.js';

const principal = { userId: 'observation-user', threadId: 'observation-thread', catId: 'codex-astra' };
const quote = (s) => `'${s.replaceAll("'", `'"'"'`)}'`;

function privateRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'managed-observation-'));
  const previous = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function unavailableSelfSnapshot(t, enabled) {
  const spawnSync = childProcess.spawnSync;
  let failures = 0;
  childProcess.spawnSync = (file, args, options) => {
    if (enabled() && file === '/bin/ps' && args?.[0] === '-p' && args[1] === String(process.pid)) {
      failures++;
      return { status: null, stdout: '', stderr: '', error: new Error('process observation unavailable') };
    }
    return spawnSync(file, args, options);
  };
  syncBuiltinESMExports();
  const restore = () => {
    childProcess.spawnSync = spawnSync;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return { restore, failures: () => failures };
}

async function command(t, delayMs = 7500, executionSlaMs = 15000) {
  const root = privateRoot(t);
  const marker = join(root, 'effect');
  const service = new ManagedJobService(root);
  const code = `console.log('ready'); setTimeout(() => { require('fs').appendFileSync(${JSON.stringify(marker)}, 'once'); }, ${delayMs})`;
  const job = await service.submit(principal, {
    command: `${quote(process.execPath)} -e ${quote(code)}`,
    cwd: root,
    originTaskId: 'observation-test',
    originInvocationId: 'private-test',
    idempotencyKey: 'one-attempt',
    executionSlaMs,
    wakeTarget: principal,
  });
  service.admit(principal, job.jobId, 'visible-admission');
  const identity = readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid);
  assert.ok(identity);
  assert.equal(recordDurableManagedGateProcess(job, identity), true);
  const chunks = [];
  const run = (options = {}) =>
    runManagedCommandWorker({
      job,
      environment: buildManagedRunnerEnvironment({ ...process.env, CAT_CAFE_DATA_DIR: root }),
      capture: (chunk) => chunks.push(String(chunk)),
      finishLog: () => writeFileSync(job.logPath, chunks.join('')),
      cancelled: () => false,
      ...options,
    });
  return { job, marker, run, service, chunks };
}

test('initial supervisor admission requires observed birth identity and retries an unavailable observation', (t) => {
  const root = privateRoot(t);
  const job = createDurableManagedGateJob('unobserved', 10000, principal, root);
  const fault = unavailableSelfSnapshot(t, () => true);
  assert.equal(claimDurableGateSupervisor(job), null);
  assert.equal(fault.failures(), 1);
  fault.restore();
  assert.ok(claimDurableGateSupervisor(job), 'an unknown observation must not be cached as identity');
});

test('known self identity never substitutes for an unknown or live competing supervisor', (t) => {
  const job = createDurableManagedGateJob('competing-supervisor', 10000, principal, privateRoot(t));
  const now = Date.now();
  const lease = claimDurableGateSupervisor(job, { now });
  assert.ok(lease);
  const successor = { ...job, supervisorEpoch: 'competing-epoch' };
  const fault = unavailableSelfSnapshot(t, () => true);
  assert.equal(claimDurableGateSupervisor(successor, { now }), null, 'unknown owner cannot be presumed dead');
  assert.equal(fault.failures(), 1, 'competing owner still receives a fresh observation');
  fault.restore();
  assert.equal(claimDurableGateSupervisor(successor, { now }), null, 'live owner retains its lease');
  assert.equal(claimDurableGateSupervisor(successor, { now: lease.leaseUntil + 1 }).fencingToken, 2);
  assert.equal(claimDurableGateSupervisor(job, { now: lease.leaseUntil + 2 }), null, 'expired owner stays fenced');
});

test('self snapshot unavailability after birth does not cancel a command or repeat its effect', async (t) => {
  const { job, marker, run, chunks } = await command(t);
  let enabled = false;
  const fault = unavailableSelfSnapshot(t, () => enabled);
  const trigger = setTimeout(() => {
    enabled = true;
    assert.equal(readUnixProcessSnapshotSync({ pids: [process.pid] }), null);
  }, 1000);
  t.after(() => clearTimeout(trigger));
  const exitCode = await run();
  assert.ok(fault.failures() >= 1, 'the OS observation failure was exercised');
  assert.equal(exitCode, 0);
  const record = rawDurableGateRecord(job);
  assert.equal(record.terminalStatus, 'green');
  assert.equal(record.result.terminationReason, 'command_exit');
  assert.equal(record.cancel, undefined);
  assert.equal(record.supervisorFence, 1);
  assert.equal(record.cleanupProven, true);
  assert.equal(readFileSync(marker, 'utf8'), 'once');
  assert.doesNotMatch(chunks.join(''), /lost its execution fence/);
});

test('a proven cleanup is persisted before ordinary command terminal settlement', async (t) => {
  const { job, run } = await command(t, 0);
  assert.equal(await run(), 0);
  assert.equal(rawDurableGateRecord(job).cleanupProven, true);
});

test('revoked supervisor authority stops the exact attempt without inventing explicit cancellation', async (t) => {
  const { job, marker, run } = await command(t);
  let successorRecord;
  const revoke = setTimeout(() => {
    const successor = { ...job, supervisorEpoch: 'authorized-test-successor' };
    const now = Date.now() + 61000;
    assert.ok(claimDurableGateSupervisor(successor, { now }));
    assert.equal(writeDurableGateRecord(successor, { ...rawDurableGateRecord(job), updatedAt: now }, { now }), true);
    successorRecord = rawDurableGateRecord(job);
  }, 1000);
  t.after(() => clearTimeout(revoke));
  let cleanup;
  assert.equal(
    await run({
      cleanupAttempt: async (...args) => {
        cleanup = await cleanupAndDrainDurableManagedGateAttempt(...args);
        return cleanup;
      },
    }),
    70,
  );
  assert.ok(cleanup.proven, 'the old worker must stop and drain only its own attempt');
  assert.equal(existsSync(marker), false);
  assert.deepEqual(rawDurableGateRecord(job), successorRecord, 'the old worker cannot overwrite successor truth');
  assert.equal(successorRecord.cancel, undefined);
  assert.equal(successorRecord.pendingResult, undefined);
});

for (const cause of ['cancelled', 'timed_out']) {
  test(`${cause} remains authoritative when self observation becomes unavailable`, async (t) => {
    const { job, marker, run, service } = await command(t, 7500, cause === 'timed_out' ? 1000 : 15000);
    let enabled = false;
    unavailableSelfSnapshot(t, () => enabled);
    const trigger = setTimeout(() => {
      enabled = true;
      if (cause === 'cancelled') service.cancel(principal, job.jobId);
    }, 500);
    t.after(() => clearTimeout(trigger));
    assert.equal(await run(), cause === 'cancelled' ? 143 : 124);
    const record = rawDurableGateRecord(job);
    assert.equal(record.terminalStatus, cause);
    assert.equal(record.result.terminationReason, cause === 'cancelled' ? 'explicit_cancel' : 'runtime_deadline');
    assert.equal(record.cleanupProven, true);
    assert.equal(existsSync(marker), false);
  });
}
