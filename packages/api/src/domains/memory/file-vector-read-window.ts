import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  decodeReadWindowNativeSnapshot,
  type FileVectorReadWindowSnapshot,
} from './file-vector-read-window-diagnostics.js';

export type { FileVectorReadWindowSnapshot } from './file-vector-read-window-diagnostics.js';
export type FileVectorQueryReader = <T>(query: () => T) => T;

export function prepareFileVectorReadWindow(
  db: Database.Database,
  extensionPath = fileURLToPath(new URL('../../../dist/native/sqlite-read-window.dylib', import.meta.url)),
  onObservation?: (snapshot: FileVectorReadWindowSnapshot) => void,
): FileVectorQueryReader | undefined {
  let snapshot: FileVectorReadWindowSnapshot = {
    prepared: false,
    active: null,
    reason: 'not_attempted',
    counters: null,
    preload: null,
    cleanup: null,
  };
  function notify() {
    try {
      onObservation?.({ ...snapshot });
    } catch {
      /* Diagnostics do not own the query. */
    }
  }
  const unavailable = (reason: FileVectorReadWindowSnapshot['reason']) => {
    snapshot = { ...snapshot, reason };
    notify();
  };
  if (process.platform !== 'darwin') {
    unavailable('unsupported_platform');
    return;
  }
  if (!db.readonly) {
    unavailable('not_readonly');
    return;
  }
  if (db.name === ':memory:') {
    unavailable('in_memory');
    return;
  }
  try {
    db.loadExtension(extensionPath);
  } catch {
    unavailable('extension_unavailable');
    return;
  }
  let begin: Database.Statement;
  let end: Database.Statement;
  try {
    // The same two lifecycle statements; snapshot only returns existing counters.
    begin = db.prepare(
      'SELECT memory_read_window_begin() AS active, memory_read_window_snapshot() AS snapshot FROM sqlite_schema LIMIT 1',
    );
    end = db.prepare('SELECT memory_read_window_end() AS released, memory_read_window_snapshot() AS snapshot');
  } catch {
    unavailable('interface_unavailable');
    return;
  }
  snapshot = { ...snapshot, prepared: true };
  notify();

  function finishSnapshot(queryFailed: boolean): void {
    let cleanup = false;
    let counters: FileVectorReadWindowSnapshot['counters'] = null;
    let preload: FileVectorReadWindowSnapshot['preload'] = null;
    try {
      const result = end.get() as { released: number; snapshot: unknown };
      const observed = decodeReadWindowNativeSnapshot(result.snapshot);
      counters = observed?.counters ?? null;
      preload = observed?.preload ?? null;
      cleanup = Boolean(result.released);
      if (!cleanup) throw new Error('SQLite read-window cleanup failed');
    } catch (error) {
      // A failed cleanup must not leave a mapping usable by a later snapshot.
      try {
        db.close();
      } catch {
        /* The worker owns final connection disposal. */
      }
      if (!queryFailed) throw error;
    } finally {
      snapshot = { ...snapshot, cleanup, counters, preload };
      notify();
    }
  }

  function readSnapshot<T>(query: () => T): T {
    const result = begin.get() as { active: number; snapshot: unknown } | undefined;
    const active = Boolean(result?.active);
    const observed = decodeReadWindowNativeSnapshot(result?.snapshot);
    snapshot = {
      prepared: true,
      active,
      reason: observed?.reason ?? 'diagnostic_unavailable',
      counters: null, // No completed counts exist if this SELECT is killed.
      preload: null,
      cleanup: null,
    };
    notify();
    if (!active) return query();
    let value!: T;
    let originalError: unknown;
    let failed = false;
    try {
      value = query();
    } catch (error) {
      failed = true;
      originalError = error;
    }
    finishSnapshot(failed);
    if (failed) throw originalError;
    return value;
  }

  return <T>(query: () => T): T =>
    db.inTransaction ? readSnapshot(query) : db.transaction(() => readSnapshot(query)).deferred();
}
