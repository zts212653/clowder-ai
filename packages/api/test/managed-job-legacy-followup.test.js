import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createDurableManagedGateJob } from '../dist/domains/managed-job/durable-managed-gate-job.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';

test('a live legacy writer remains readable by its original ID across recovery workers and an interrupted import', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-followup-'));
  const principal = { userId: 'legacy-owner', threadId: 'legacy-thread', catId: 'codex61-sol' };
  const job = createDurableManagedGateJob('hold-ball-legacy', 60_000, principal, root);
  const marker = join(root, 'starts');
  const child = fork(
    new URL('./helpers/legacy-managed-job-writer.mjs', import.meta.url),
    [JSON.stringify(job), marker],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  t.after(async () => {
    if (existsSync(join(root, 'managed-gate-jobs'))) chmodSync(join(root, 'managed-gate-jobs'), 0o700);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const [ready] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(5000) }),
    once(child, 'exit').then(([code, signal]) => {
      throw new Error(`legacy fixture exited before ready: ${code}/${signal}: ${stderr}`);
    }),
  ]);
  assert.equal(ready.kind, 'ready', stderr);
  const service = new ManagedJobService(root);
  await service.reconcile([job]);
  const restored = new ManagedJobService(root);
  assert.equal(restored.get(principal, job.jobId).state, 'running');
  // File-addressed reads/writes remain possible, while directory enumeration is forbidden on the real filesystem.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    chmodSync(join(root, 'managed-gate-jobs'), 0o311);
    assert.throws(() => readdirSync(join(root, 'managed-gate-jobs')), { code: 'EACCES' });
  }
  await restored.reconcile([], Date.now() + 31_000);
  assert.equal(restored.get(principal, job.jobId).state, 'running');
  assert.equal(readFileSync(marker, 'utf8'), 'start\n', 'recovery never re-runs the original action');

  const db = new Database(join(root, 'managed-jobs', 'supervisor.sqlite'));
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER interrupt_import BEFORE UPDATE OF disposition ON managed_job_legacy_refs
    WHEN NEW.disposition='legacy_migrated' BEGIN SELECT RAISE(ABORT,'injected_import_crash'); END`);
  const completion = once(child, 'message', { signal: AbortSignal.timeout(5000) });
  child.send('complete');
  const [terminal] = await completion;
  assert.equal(terminal.kind, 'terminal');
  await restored.reconcile([], Date.now() + 62_000);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM managed_jobs WHERE job_id=?').get(job.jobId).n,
    0,
    'history insert and migration disposition roll back together',
  );
  assert.equal(
    restored.get(principal, job.jobId).state,
    'failed',
    'the original file remains readable during import recovery',
  );
  db.exec('DROP TRIGGER interrupt_import');
  await new ManagedJobService(root).reconcile([], Date.now() + 93_000);
  const final = new ManagedJobService(root).get(principal, job.jobId);
  assert.deepEqual(final.result, terminal.result);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_jobs WHERE job_id=?').get(job.jobId).n, 1);
  assert.equal(
    db.prepare('SELECT disposition FROM managed_job_legacy_refs WHERE job_id=?').get(job.jobId).disposition,
    'legacy_migrated',
  );
  assert.equal(existsSync(job.recordPath), true, 'migration retains the original disk evidence');
  assert.equal(readFileSync(marker, 'utf8'), 'start\n');
});
