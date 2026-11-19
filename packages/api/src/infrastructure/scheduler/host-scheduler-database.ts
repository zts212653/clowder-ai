import { mkdir, mkdtemp } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, CURRENT_SCHEMA_VERSION, PRAGMA_SETUP } from '../../domains/memory/schema.js';
import { prepareGenerationInvalidationConnection } from '../../domains/memory/vector-generation-invalidation.js';

/** Open the Host's connection to the existing mixed database, before any memory provider activation. */
export async function openHostSchedulerDatabase(dbPath: string): Promise<Database.Database> {
  if (dbPath !== ':memory:') await mkdir(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    const schemaExists = db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_version'")
      .get();
    const version = schemaExists ? db.prepare('SELECT MAX(version) FROM schema_version').pluck().get() : null;
    if (version == null) {
      const existingData = db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('schema_version', 'sqlite_sequence') LIMIT 1",
        )
        .get();
      if (existingData) throw new Error('Unsupported unversioned legacy evidence database');
    } else if (typeof version !== 'number' || version < 1 || version > CURRENT_SCHEMA_VERSION) {
      throw new Error(`Unsupported legacy evidence schema ${String(version)}`);
    }

    if (version != null && version < CURRENT_SCHEMA_VERSION && dbPath !== ':memory:') {
      const backupDir = await mkdtemp(join(dirname(dbPath), '.legacy-evidence-backup-'));
      await db.backup(join(backupDir, basename(dbPath)));
    }
    db.exec(PRAGMA_SETUP);
    if (version !== CURRENT_SCHEMA_VERSION) {
      // The historical migration may execute existing evidence triggers. Install the
      // connection-local trigger functions before running the legacy bridge.
      prepareGenerationInvalidationConnection(db);
      applyMigrations(db);
    }
    // Verify the shared layout before either owner opens a production connection.
    db.prepare('SELECT anchor, kind, source_path FROM evidence_docs LIMIT 0');
    db.prepare('SELECT id, task_id, subject_key, outcome FROM task_run_ledger LIMIT 0');
    db.prepare('SELECT task_id, total, delivered, failed, skipped FROM task_run_stats LIMIT 0');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
