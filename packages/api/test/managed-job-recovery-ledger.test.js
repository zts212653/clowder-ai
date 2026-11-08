import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { settleDurableManagedGateJobFromRunner } from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';

const principal = { userId: 'recovery-user', threadId: 'recovery-thread', catId: 'codex61-sol' };
const result = { exitCode: 3, timedOut: false, durationMs: 23, tailOutput: 'original result' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'managed-job-recovery-'));
  mkdirSync(join(root, 'managed-jobs'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: join(root, 'managed-jobs', 'supervisor.sqlite'), service: new ManagedJobService(root) };
}

function historyDescriptor(root, n) {
  const jobId = `managed-job-${String(n).padStart(40, '0')}`;
  return {
    kind: 'command',
    recordStorage: 'sqlite_v1',
    jobId,
    originTaskId: `hold-ball-history-${n}`,
    supervisorEpoch: 'historical-epoch',
    executionSlaMs: 1000,
    wallSlaMs: 1000,
    wakeTarget: principal,
    recordPath: join(root, 'managed-jobs', `${jobId}.json`),
    gateReceiptPath: join(root, 'managed-jobs', `${jobId}.gate.json`),
    logPath: join(root, 'managed-jobs', `${jobId}.log`),
    definition: {
      principal,
      command: 'printf history',
      cwd: root,
      originInvocationId: 'old-invocation',
      idempotencyKey: `history-${n}`,
      retryPolicy: 'never',
      maxConcurrent: 4,
    },
  };
}

test('upgrading settled native history never hydrates it into a periodic recovery batch', async (t) => {
  for (const history of [10, 100]) {
    const { root, file, service } = fixture(t);
    const db = new Database(file);
    // The pre-upgrade schema has no recovery columns. These are settled historical facts, not pending wakes.
    db.exec(`CREATE TABLE managed_jobs(job_id TEXT PRIMARY KEY, principal_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
      record_json TEXT NOT NULL, UNIQUE(principal_key, idempotency_key))`);
    const insert = db.prepare('INSERT INTO managed_jobs VALUES (?, ?, ?, ?, ?, ?)');
    for (let n = 1; n <= history; n++) {
      const job = historyDescriptor(root, n);
      const record = {
        version: 1,
        jobId: job.jobId,
        originTaskId: job.originTaskId,
        supervisorEpoch: job.supervisorEpoch,
        state: 'terminal',
        terminalStatus: 'failed',
        revision: 3,
        createdAt: 1,
        updatedAt: 2,
        result,
        descriptor: job,
      };
      insert.run(
        job.jobId,
        JSON.stringify(Object.values(principal)),
        `history-${n}`,
        'terminal',
        3,
        JSON.stringify(record),
      );
    }
    db.close();
    const recovered = await service.reconcile([], Date.now());
    assert.equal(recovered.length, 0, `${history} settled rows must add zero recovery candidates`);
  }
});

test('the first native terminal commit contains one stable production intent with the original result', async (t) => {
  const { root, file, service } = fixture(t);
  const job = await service.submit(principal, {
    command: 'printf original',
    cwd: root,
    originTaskId: 'hold-ball-terminal',
    originInvocationId: 'original-invocation',
    idempotencyKey: 'terminal',
    executionSlaMs: 1000,
    wakeTarget: principal,
  });
  service.admit(principal, job.jobId, 'original-admission');
  assert.equal(settleDurableManagedGateJobFromRunner(job, result), true);
  const db = new Database(file);
  try {
    const row = db.prepare('SELECT * FROM managed_jobs WHERE job_id=?').get(job.jobId);
    const recovery = JSON.parse(row.recovery_json ?? 'null');
    assert.equal(row.state, 'terminal');
    assert.deepEqual(JSON.parse(row.record_json).result, result);
    assert.ok(recovery?.wakeIntent, 'terminal truth must never commit without its production intent');
    assert.equal(recovery.wakeIntent.terminalEpoch, row.revision);
    assert.equal(recovery.wakeIntent.key, `${job.jobId}:${row.revision}:${JSON.stringify(Object.values(principal))}`);
    assert.equal(recovery.wakeIntent.status, 'pending');
    assert.equal(settleDurableManagedGateJobFromRunner(job, { ...result, exitCode: 0 }), false);
    assert.deepEqual(db.prepare('SELECT * FROM managed_jobs WHERE job_id=?').get(job.jobId), row);
  } finally {
    db.close();
  }
});

test('a never-admitted terminal job records a typed no-wake outcome in its terminal transaction', async (t) => {
  const { root, file, service } = fixture(t);
  const job = await service.submit(principal, {
    command: 'printf never-started',
    cwd: root,
    originTaskId: 'hold-ball-never-admitted',
    originInvocationId: 'not-started',
    idempotencyKey: 'not-started',
    executionSlaMs: 1000,
    wakeTarget: principal,
  });
  settleDurableManagedGateJobFromRunner(job, { ...result, cancelled: true });
  const db = new Database(file);
  try {
    const fact = JSON.parse(
      db.prepare('SELECT recovery_json FROM managed_jobs WHERE job_id=?').get(job.jobId).recovery_json,
    );
    assert.equal(fact.wakeIntent.status, 'not_applicable');
    assert.equal(fact.nextAttemptAt, null);
  } finally {
    db.close();
  }
});
