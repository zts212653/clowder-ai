import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { reconcileGenerationInvalidations } from './vector-generation-invalidation.js';
import { type VectorGenerationId, vectorGenerationTables } from './vector-generation-tables.js';

/** Called only by the existing maintenance child while the original store holds writer admission. */
export function reconcileVectorGenerationDatabase(dbPath: string, generationId: VectorGenerationId): void {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    sqliteVec.load(db);
    reconcileGenerationInvalidations(db, vectorGenerationTables(generationId));
  } finally {
    db.close();
  }
}
