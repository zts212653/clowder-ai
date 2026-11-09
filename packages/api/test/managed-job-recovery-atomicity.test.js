import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { settleDurableManagedGateJobFromRunner } from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import {
  acknowledgeManagedJobWake,
  readManagedJobRecovery,
  selectManagedJobRecoveryDue,
  updateManagedJobRecovery,
} from '../dist/domains/managed-job/managed-job-recovery-ledger.js';
import {
  applyManagedJobRecoveryOutcome,
  initialManagedJobRecovery,
} from '../dist/domains/managed-job/managed-job-recovery-state.js';
import { auditRecoverySqlite } from './helpers/recovery-store-audit.js';

const principal = { userId: 'owner', threadId: 'thread', catId: 'codex61-sol' };
const result = { exitCode: 3, timedOut: false, durationMs: 20, tailOutput: 'unchanged result' };

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'managed-job-atomicity-'));
  const service = new ManagedJobService(root, 1);
  const job = await service.submit(principal, {
    command: 'printf original',
    cwd: root,
    originTaskId: 'hold-ball-atomicity',
    originInvocationId: 'source',
    idempotencyKey: 'original',
    executionSlaMs: 1000,
    wakeTarget: principal,
  });
  service.admit(principal, job.jobId, 'original-admission');
  const db = new Database(join(root, 'managed-jobs', 'supervisor.sqlite'));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, service, job, db };
}

test('a crash at the intent write rolls back terminal truth, then retry commits both exactly once', async (t) => {
  const { job, db } = await fixture(t);
  db.exec(`CREATE TRIGGER fail_intent BEFORE UPDATE OF recovery_json ON managed_jobs
    WHEN NEW.state='terminal' BEGIN SELECT RAISE(ABORT, 'injected_intent_write_failure'); END`);
  assert.throws(() => settleDurableManagedGateJobFromRunner(job, result), /injected_intent_write_failure/);
  assert.equal(db.prepare('SELECT state FROM managed_jobs WHERE job_id=?').get(job.jobId).state, 'queued');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM managed_job_transitions WHERE state='terminal'").get().n, 0);
  db.exec('DROP TRIGGER fail_intent');
  assert.equal(settleDurableManagedGateJobFromRunner(job, result), true);
  const terminal = db.prepare('SELECT record_json, revision FROM managed_jobs WHERE job_id=?').get(job.jobId);
  const fact = readManagedJobRecovery(job);
  assert.equal(fact.recovery.wakeIntent.status, 'pending');
  // Producer acknowledgment after a restart cannot mutate terminal bytes or create another business transition.
  assert.equal(acknowledgeManagedJobWake(job, fact.recovery.wakeIntent.key, 'original-message', Date.now()), true);
  assert.equal(acknowledgeManagedJobWake(job, fact.recovery.wakeIntent.key, 'original-message', Date.now()), true);
  assert.equal(acknowledgeManagedJobWake(job, fact.recovery.wakeIntent.key, 'different-message', Date.now()), false);
  assert.deepEqual(
    db.prepare('SELECT record_json, revision FROM managed_jobs WHERE job_id=?').get(job.jobId),
    terminal,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM managed_job_transitions WHERE state='terminal'").get().n, 1);
});

test('fixed due work uses its real partial index while settled history grows tenfold', async (t) => {
  const { job, db } = await fixture(t);
  const fact = readManagedJobRecovery(job);
  assert.equal(updateManagedJobRecovery(job, fact.revision, initialManagedJobRecovery(1)), true);
  for (const count of [100, 1000]) {
    db.prepare(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n < ?)
      INSERT OR IGNORE INTO managed_jobs(job_id, principal_key, idempotency_key, state, revision, record_json, recovery_json)
      SELECT 'history-'||n, 'history', 'history-'||n, 'terminal', 1, '{"state":"terminal"}',
        '{"version":1,"attempts":0,"nextAttemptAt":null}' FROM rows`).run(count);
    const audit = auditRecoverySqlite(db);
    const selected = selectManagedJobRecoveryDue(audit.db, 2, 1);
    assert.deepEqual(
      selected.map((row) => row.jobId),
      [job.jobId],
    );
    audit.assertIndex('managed_jobs_recovery_due');
    assert.ok(
      audit.reads.every(({ plan }) => plan.some(({ detail }) => /SEARCH.*managed_jobs_recovery_due/.test(detail))),
    );
  }
});

test('waiting and stale observations preserve the budget; parked responsibility survives index rebuild', async (t) => {
  const { job, db, service } = await fixture(t);
  let recovery = initialManagedJobRecovery(1);
  for (let n = 0; n < 100; n++) recovery = applyManagedJobRecoveryOutcome(recovery, { kind: 'waiting' }, job.jobId, n);
  assert.equal(recovery.attempts, 0);
  assert.equal(applyManagedJobRecoveryOutcome(recovery, { kind: 'stale' }, job.jobId, 1), recovery);
  for (let n = 0; n < 5; n++)
    recovery = applyManagedJobRecoveryOutcome(
      recovery,
      { kind: 'retryable_error', reason: 'cleanup_unproven' },
      job.jobId,
      n,
    );
  assert.equal(recovery.disposition, 'parked');
  assert.equal(recovery.attempts, 5);
  assert.equal(recovery.notification, undefined);
  // The original recovery disposition retires automatic work, never the execution or its concurrency slot.
  recovery = { ...recovery, nextAttemptAt: null };
  assert.equal(updateManagedJobRecovery(job, readManagedJobRecovery(job).revision, recovery), true);
  db.exec(`DROP INDEX managed_jobs_recovery_due; CREATE INDEX managed_jobs_recovery_due
    ON managed_jobs(json_extract(recovery_json,'$.nextAttemptAt'),job_id)
    WHERE json_extract(recovery_json,'$.nextAttemptAt') IS NOT NULL`);
  assert.deepEqual(selectManagedJobRecoveryDue(db, 1e15, 100), []);
  assert.equal(service.get(principal, job.jobId).state, 'queued');
  await assert.rejects(
    service.submit(principal, {
      command: 'printf second',
      cwd: job.definition.cwd,
      originTaskId: 'hold-ball-next',
      originInvocationId: 'next',
      idempotencyKey: 'next',
      executionSlaMs: 1000,
      wakeTarget: principal,
    }),
    /budget_exhausted/,
  );
});

test('a malformed native business row is preserved and disposed without suppressing a healthy neighbour', async (t) => {
  const { service, job, db } = await fixture(t);
  const badId = `managed-job-${'0'.repeat(40)}`;
  db.prepare(`INSERT INTO managed_jobs(job_id,principal_key,idempotency_key,state,revision,record_json,recovery_json)
    VALUES (?,'bad-owner','bad','running',1,'{}','{"version":1,"attempts":0,"nextAttemptAt":0}')`).run(badId);
  const observations = await service.reconcile([], Date.now());
  assert.ok(observations.some((row) => row.job.jobId === job.jobId));
  const bad = db.prepare('SELECT record_json,recovery_json FROM managed_jobs WHERE job_id=?').get(badId);
  assert.equal(bad.record_json, '{}');
  assert.equal(JSON.parse(bad.recovery_json).disposition, 'needs_attention');
  assert.equal(JSON.parse(bad.recovery_json).nextAttemptAt, null);
});
