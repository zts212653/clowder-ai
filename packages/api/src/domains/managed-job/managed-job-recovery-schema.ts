import type Database from 'better-sqlite3';

export const MANAGED_JOB_RECOVERY_DUE_EXPRESSION = "json_extract(recovery_json, '$.nextAttemptAt')";

/** Recovery metadata is part of the existing owner row, independent of immutable terminal business bytes. */
export function migrateManagedJobRecoverySchema(database: Database.Database): void {
  const columns = new Set(
    (database.prepare('PRAGMA table_info(managed_jobs)').all() as { name: string }[]).map(({ name }) => name),
  );
  for (const [name, definition] of [
    ['recovery_json', `TEXT NOT NULL DEFAULT '{"version":1,"attempts":0,"nextAttemptAt":0}'`],
    ['recovery_revision', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (columns.has(name)) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      // Another API/worker can have completed this migration while we were waiting for the lock.
      const current = database.prepare('PRAGMA table_info(managed_jobs)').all() as { name: string }[];
      if (!current.some((column) => column.name === name)) {
        database.exec(`ALTER TABLE managed_jobs ADD COLUMN ${name} ${definition}`);
        if (name === 'recovery_json')
          database.exec(`UPDATE managed_jobs SET recovery_json='{"version":1,"attempts":0,"nextAttemptAt":null}'
            WHERE state='terminal'`);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  database.exec(`CREATE INDEX IF NOT EXISTS managed_jobs_recovery_due
    ON managed_jobs(${MANAGED_JOB_RECOVERY_DUE_EXPRESSION}, job_id)
    WHERE ${MANAGED_JOB_RECOVERY_DUE_EXPRESSION} IS NOT NULL`);
  database.exec(`CREATE TABLE IF NOT EXISTS managed_job_legacy_refs (
      job_id TEXT PRIMARY KEY, source_path TEXT NOT NULL UNIQUE, descriptor_json TEXT,
      disposition TEXT NOT NULL DEFAULT 'unclassified', was_live INTEGER NOT NULL DEFAULT 0,
      recovery_revision INTEGER NOT NULL DEFAULT 0, recovery_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS managed_job_legacy_recovery_due
      ON managed_job_legacy_refs(${MANAGED_JOB_RECOVERY_DUE_EXPRESSION}, job_id)
      WHERE ${MANAGED_JOB_RECOVERY_DUE_EXPRESSION} IS NOT NULL;
    CREATE TABLE IF NOT EXISTS managed_job_migrations (
      name TEXT PRIMARY KEY, discovered_at INTEGER NOT NULL, discovered_count INTEGER NOT NULL
    )`);
}
