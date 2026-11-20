import Database from 'better-sqlite3';
import { applyMigrations } from './schema.js';
import { prepareGenerationInvalidationConnection } from './vector-generation-invalidation.js';

/** File schema preparation runs in the existing maintenance process. Each live
 * connection still installs its own foreign-key policy and invalidation functions. */
export function openEvidenceDatabase(dbPath: string, mode: 'schema' | 'prepared' | 'read'): Database.Database {
  const db = new Database(dbPath, { readonly: mode === 'read', fileMustExist: mode !== 'schema' });
  try {
    if (mode === 'schema') db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (mode !== 'read') {
      // Existing source triggers can run during schema repair itself.
      prepareGenerationInvalidationConnection(db);
      if (mode === 'schema') {
        applyMigrations(db);
        prepareGenerationInvalidationConnection(db);
      }
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      /* Preserve the schema/open error if closing its failed connection also fails. */
    }
    throw error;
  }
}
