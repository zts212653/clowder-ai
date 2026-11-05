import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { readLegacyManagedJobById } from '../dist/domains/managed-job/managed-job-legacy-read.js';
import { selectLegacyManagedJobRecoveryDue } from '../dist/domains/managed-job/managed-job-legacy-reference-store.js';
import { migrateManagedJobRecoverySchema } from '../dist/domains/managed-job/managed-job-recovery-schema.js';
import { auditRecoverySqlite } from './helpers/recovery-store-audit.js';

test('one-time discovery retains terminal and unknown identities; rebuild cannot resurrect them or issue historical wakes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-census-'));
  const directory = join(root, 'managed-gate-jobs');
  mkdirSync(directory);
  const result = { exitCode: 3, timedOut: false, durationMs: 4, tailOutput: 'kept original' };
  const jobId = 'managed-gate-11111111-1111-4111-8111-111111111111';
  const original = JSON.stringify({
    version: 1,
    jobId,
    originTaskId: 'hold-ball-history',
    state: 'terminal',
    terminalStatus: 'failed',
    supervisorEpoch: 'old-epoch',
    result,
    createdAt: 1,
    updatedAt: 2,
  });
  writeFileSync(join(directory, `${jobId}.json`), original);
  writeFileSync(join(directory, 'corrupt.json'), '{');
  writeFileSync(
    join(directory, 'mismatch.json'),
    JSON.stringify({ jobId: 'different', originTaskId: 'old', state: 'running' }),
  );
  const service = new ManagedJobService(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await service.reconcile([], Date.now());
  const db = new Database(join(root, 'managed-jobs', 'supervisor.sqlite'));
  t.after(() => db.close());
  const read = readLegacyManagedJobById(root, jobId);
  assert.equal(read.kind, 'record');
  assert.deepEqual(read.record.result, result);
  assert.equal(readLegacyManagedJobById(root, 'corrupt').kind, 'unknown');
  assert.equal(readLegacyManagedJobById(root, 'mismatch').kind, 'unknown');
  assert.equal(
    db
      .prepare(`SELECT COUNT(*) AS n FROM
    (SELECT job_id FROM managed_jobs UNION SELECT job_id FROM managed_job_legacy_refs)`)
      .get().n,
    3,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_job_legacy_refs').get().n, 3);
  assert.equal(readFileSync(join(directory, `${jobId}.json`), 'utf8'), original);
  for (const row of db.prepare('SELECT recovery_json FROM managed_job_legacy_refs').all()) {
    const recovery = JSON.parse(row.recovery_json);
    assert.equal(recovery.nextAttemptAt, null);
    assert.equal(recovery.wakeIntent, undefined, 'importing historical truth never creates an execution');
  }
  // A deliberately unregistered fixture file proves subsequent runs do not discover directory additions.
  // Real new creators have the separate before-create registration contract.
  writeFileSync(join(directory, 'must-not-enumerate.json'), '{');
  await new ManagedJobService(root).reconcile([], Date.now() + 60_000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM managed_job_legacy_refs').get().n, 3);
  db.exec('DROP INDEX managed_job_legacy_recovery_due');
  migrateManagedJobRecoverySchema(db);
  for (const history of [100, 1000]) {
    db.prepare(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n < ?)
      INSERT OR IGNORE INTO managed_job_legacy_refs(job_id,source_path,disposition,recovery_json)
      SELECT 'history-'||n,'history-source-'||n,'legacy_migrated','{"version":1,"attempts":0,"nextAttemptAt":null}' FROM rows`).run(
      history,
    );
    const audit = auditRecoverySqlite(db);
    assert.deepEqual(selectLegacyManagedJobRecoveryDue(audit.db, 1e15, 10), []);
    audit.assertIndex('managed_job_legacy_recovery_due');
    assert.ok(
      audit.reads.every(({ plan }) =>
        plan.some(({ detail }) => /SEARCH.*managed_job_legacy_recovery_due/.test(detail)),
      ),
    );
  }
});
