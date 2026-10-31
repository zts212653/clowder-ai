import Database from 'better-sqlite3';
import type { WalCheckpointResult } from './memory-process-protocol.js';

/** Maintenance only: no migration, recovery, business write, or writer transaction. */
export function checkpointMemoryDatabase(dbPath: string): WalCheckpointResult {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 0');
    const [result] = db.pragma('main.wal_checkpoint(PASSIVE)') as WalCheckpointResult[];
    if (!result) throw new Error('SQLite did not report checkpoint progress');
    return result;
  } finally {
    db.close();
  }
}
