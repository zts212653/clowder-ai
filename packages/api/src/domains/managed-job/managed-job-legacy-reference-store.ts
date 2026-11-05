import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { validateDurableManagedGateJob } from './durable-managed-gate-job-validation.js';
import { closeSupervisorStore, openSupervisorStore, transaction } from './managed-job-database.js';
import { MANAGED_JOB_RECOVERY_DUE_EXPRESSION } from './managed-job-recovery-schema.js';
import {
  initialManagedJobRecovery,
  type ManagedJobRecoveryFact,
  parseManagedJobRecovery,
} from './managed-job-recovery-state.js';
import type { DurableManagedGateJob } from './managed-job-types.js';

export interface LegacyManagedJobReference {
  jobId: string;
  sourcePath: string;
  job: DurableManagedGateJob | null;
  disposition: string;
  wasLive: boolean;
  revision: number;
  recovery: ManagedJobRecoveryFact;
}

interface ReferenceRow {
  job_id: string;
  source_path: string;
  descriptor_json: string | null;
  disposition: string;
  was_live: number;
  recovery_revision: number;
  recovery_json: string;
}

export function openLegacyReferenceStore(dataRoot: string): Database.Database {
  return openSupervisorStore({ recordPath: join(dataRoot, 'managed-jobs', 'ledger.json') });
}

function decode(row: ReferenceRow): LegacyManagedJobReference {
  let job: DurableManagedGateJob | null = null;
  let recovery: ManagedJobRecoveryFact;
  try {
    job = row.descriptor_json ? (JSON.parse(row.descriptor_json) as DurableManagedGateJob) : null;
  } catch {
    /* A malformed descriptor stays an unattributed, queryable reference. */
  }
  try {
    recovery = parseManagedJobRecovery(row.recovery_json);
  } catch {
    recovery = initialManagedJobRecovery(0);
  }
  return {
    jobId: row.job_id,
    sourcePath: row.source_path,
    job,
    disposition: row.disposition,
    wasLive: row.was_live === 1,
    revision: row.recovery_revision,
    recovery,
  };
}

export function readLegacyManagedJobReference(dataRoot: string, jobId: string): LegacyManagedJobReference | null {
  const db = openLegacyReferenceStore(dataRoot);
  try {
    const row = db.prepare('SELECT * FROM managed_job_legacy_refs WHERE job_id=?').get(jobId) as
      | ReferenceRow
      | undefined;
    return row ? decode(row) : null;
  } finally {
    closeSupervisorStore(db);
  }
}

/** Discovery has its own durable completion fact. Execution termination is classified later, per due reference. */
export function discoverLegacyManagedJobReferences(dataRoot: string, now: number): void {
  const db = openLegacyReferenceStore(dataRoot);
  try {
    if (db.prepare('SELECT 1 FROM managed_job_migrations WHERE name=?').get('legacy_directory_v1')) return;
    const directory = join(dataRoot, 'managed-gate-jobs');
    const files = existsSync(directory)
      ? readdirSync(directory, { withFileTypes: true }).filter(
          (entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.gate.json'),
        )
      : [];
    transaction(db, () => {
      if (db.prepare('SELECT 1 FROM managed_job_migrations WHERE name=?').get('legacy_directory_v1')) return;
      const insert = db.prepare(
        `INSERT OR IGNORE INTO managed_job_legacy_refs(job_id,source_path,recovery_json) VALUES (?,?,?)`,
      );
      for (const file of files)
        insert.run(file.name.slice(0, -5), join(directory, file.name), JSON.stringify(initialManagedJobRecovery(now)));
      db.prepare('INSERT INTO managed_job_migrations VALUES (?,?,?)').run('legacy_directory_v1', now, files.length);
    });
  } finally {
    closeSupervisorStore(db);
  }
}

/** New legacy creators register before writing the first file; an old live writer only updates its existing file. */
export function registerLegacyManagedJobReference(job: DurableManagedGateJob, now = Date.now()): void {
  if (job.recordStorage === 'sqlite_v1') return;
  const root = dirname(dirname(job.recordPath));
  if (!validateDurableManagedGateJob(job, job.originTaskId, root))
    throw new Error('invalid_legacy_managed_job_descriptor');
  const db = openLegacyReferenceStore(root);
  try {
    db.prepare(`INSERT INTO managed_job_legacy_refs(job_id,source_path,descriptor_json,disposition,recovery_json)
      VALUES (?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET descriptor_json=COALESCE(managed_job_legacy_refs.descriptor_json,excluded.descriptor_json)`).run(
      job.jobId,
      resolve(job.recordPath),
      JSON.stringify(job),
      existsSync(job.recordPath) ? 'unclassified' : 'reserved',
      JSON.stringify(initialManagedJobRecovery(now)),
    );
  } finally {
    closeSupervisorStore(db);
  }
}

export function selectLegacyManagedJobRecoveryDue(
  db: Database.Database,
  now: number,
  limit = 100,
): LegacyManagedJobReference[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_legacy_recovery_batch_limit');
  return (
    db
      .prepare(`SELECT * FROM managed_job_legacy_refs
      WHERE ${MANAGED_JOB_RECOVERY_DUE_EXPRESSION} IS NOT NULL AND ${MANAGED_JOB_RECOVERY_DUE_EXPRESSION} <= ?
      ORDER BY ${MANAGED_JOB_RECOVERY_DUE_EXPRESSION},job_id LIMIT ?`)
      .all(now, limit) as ReferenceRow[]
  ).map(decode);
}

export function updateLegacyManagedJobReference(
  dataRoot: string,
  original: LegacyManagedJobReference,
  next: LegacyManagedJobReference,
): boolean {
  const db = openLegacyReferenceStore(dataRoot);
  try {
    return (
      db
        .prepare(`UPDATE managed_job_legacy_refs SET descriptor_json=?,disposition=?,was_live=?,
      recovery_json=?,recovery_revision=recovery_revision+1 WHERE job_id=? AND recovery_revision=?`)
        .run(
          next.job ? JSON.stringify(next.job) : null,
          next.disposition,
          next.wasLive ? 1 : 0,
          JSON.stringify(next.recovery),
          original.jobId,
          original.revision,
        ).changes === 1
    );
  } finally {
    closeSupervisorStore(db);
  }
}
