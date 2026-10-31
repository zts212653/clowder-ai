import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  rawDurableGateRecord,
  recordDurableManagedGateProcess,
  recordManagedJobAttempt,
  writeDurableGateRecord,
} from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { reconcileManagedJobDescriptor } from '../dist/domains/managed-job/managed-job-reconcile-descriptor.js';
import { largePsFixture } from './helpers/large-ps-snapshot.mjs';

test('fenced recovery settles the original exit1 only after a complete large-host cleanup observation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'large-host-recovery-'));
  const priorDataRoot = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originals = { spawnSync: cp.spawnSync, execFile: cp.execFile, spawn: cp.spawn };
  t.after(() => {
    Object.assign(cp, originals);
    Object.defineProperty(process, 'platform', platform);
    syncBuiltinESMExports();
    if (priorDataRoot === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorDataRoot;
    rmSync(root, { recursive: true, force: true });
  });
  const service = new ManagedJobService(root);
  const principal = { userId: 'fixture-user', threadId: 'fixture-thread', catId: 'codex-astra' };
  const job = await service.submit(principal, {
    command: 'false',
    cwd: root,
    originTaskId: 'fixture-task',
    originInvocationId: 'fixture-invocation',
    idempotencyKey: 'original-observed-failure',
    executionSlaMs: 60000,
    wakeTarget: principal,
  });
  service.admit(principal, job.jobId, 'fixture-visible-admission');
  const deadPid = originals.spawnSync('/usr/bin/true').pid;
  assert.ok(Number.isSafeInteger(deadPid));
  assert.equal(
    recordDurableManagedGateProcess(job, {
      pid: deadPid,
      ppid: 1,
      pgid: deadPid,
      startedAt: 'Wed Oct 14 18:00:00 2026',
    }),
    true,
  );
  recordManagedJobAttempt(job, 'original-observed-attempt');
  const originalResult = {
    exitCode: 1,
    timedOut: false,
    cancelled: false,
    durationMs: 123,
    tailOutput: 'original failure',
    terminationReason: 'command_exit',
  };
  assert.equal(writeDurableGateRecord(job, { ...rawDurableGateRecord(job), pendingResult: originalResult }), true);

  let fixture = largePsFixture({ failPid: 2_000_599 });
  let commandStarts = 0;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  cp.spawn = () => {
    commandStarts++;
    throw new Error('recovery must not rerun the command');
  };
  cp.spawnSync = (file, args, options) => {
    if (file === '/bin/ps' && args.includes(String(deadPid)))
      return { status: 1, stdout: '', stderr: '', signal: null };
    return originals.spawnSync(file, args, options);
  };
  cp.execFile = (file, args, options, callback) => {
    if (file === process.execPath && args[0].endsWith('/ps-environment-worker.mjs')) {
      return originals.execFile(file, fixture.command(args), options, callback);
    }
    return originals.execFile(file, args, options, callback);
  };
  syncBuiltinESMExports();
  await reconcileManagedJobDescriptor(job, Date.now(), job.supervisorEpoch);
  assert.equal(rawDurableGateRecord(job).state, 'running');
  assert.deepEqual(rawDurableGateRecord(job).pendingResult, originalResult);
  assert.equal(rawDurableGateRecord(job).cleanupProven, false);

  fixture = largePsFixture();
  const recovered = await reconcileManagedJobDescriptor(job, Date.now(), job.supervisorEpoch);
  assert.equal(recovered.inspection.state, 'terminal');
  assert.equal(rawDurableGateRecord(job).terminalStatus, 'failed');
  assert.equal(rawDurableGateRecord(job).cleanupProven, true);
  assert.equal(rawDurableGateRecord(job).result.exitCode, 1);
  assert.equal(rawDurableGateRecord(job).result.terminationReason, 'command_exit');
  assert.equal(commandStarts, 0);
});
