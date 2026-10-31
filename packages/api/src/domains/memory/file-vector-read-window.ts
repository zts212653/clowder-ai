import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

export type FileVectorQueryReader = <T>(query: () => T) => T;

export function prepareFileVectorReadWindow(
  db: Database.Database,
  extensionPath = fileURLToPath(new URL('../../../dist/native/sqlite-read-window.dylib', import.meta.url)),
): FileVectorQueryReader | undefined {
  if (process.platform !== 'darwin' || !db.readonly || db.name === ':memory:') return;
  let begin: Database.Statement;
  let end: Database.Statement;
  try {
    db.loadExtension(extensionPath);
    // Prepare before attaching read diagnostics. Neither statement loads a body.
    begin = db.prepare('SELECT memory_read_window_begin() AS active FROM sqlite_schema LIMIT 1');
    end = db.prepare('SELECT memory_read_window_end() AS released');
  } catch {
    // This optional backend cannot make an otherwise usable native index fail.
    return;
  }

  function finishSnapshot(queryFailed: boolean): void {
    try {
      if (!(end.get() as { released: number }).released) throw new Error('SQLite read-window cleanup failed');
    } catch (error) {
      // A failed cleanup must not leave a mapping usable by a later snapshot.
      // close's native destructor also releases the scope; preserve an original error.
      try {
        db.close();
      } catch {
        /* The worker owns final connection disposal. */
      }
      if (!queryFailed) throw error;
    }
  }

  function readSnapshot<T>(query: () => T): T {
    if (!(begin.get() as { active: number } | undefined)?.active) return query();
    let result!: T;
    let originalError: unknown;
    let failed = false;
    try {
      result = query();
    } catch (error) {
      failed = true;
      originalError = error;
    }
    finishSnapshot(failed);
    if (failed) throw originalError;
    return result;
  }

  return <T>(query: () => T): T =>
    db.inTransaction ? readSnapshot(query) : db.transaction(() => readSnapshot(query)).deferred();
}
