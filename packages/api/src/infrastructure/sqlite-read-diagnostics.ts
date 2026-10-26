import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  captureNativeReadResources,
  type NativeReadResourceDelta,
  type NativeReadResources,
  nativeReadResourceDelta,
} from './sqlite-native-read-resources.js';

export interface SqliteNativeReadContext {
  kind: 'vector-knn';
  requestedK: number;
  dimensions: number;
}

interface NativeReadObservation extends SqliteNativeReadContext {
  resourcesBefore: NativeReadResources | null;
  resourcesAfter?: NativeReadResources | null;
  resourceDelta?: NativeReadResourceDelta | null;
}

export interface SqliteReadDiagnostic {
  databasePath: string;
  sqlFingerprint: string;
  caller: string[];
  requestId: string | null;
  startedAt: number;
  elapsedMs: number;
  rows: number | null;
  native?: NativeReadObservation;
}

export interface SqliteReadDiagnosticOptions {
  onSlowRead: (event: SqliteReadDiagnostic) => void;
  /** Paired, bounded native-call witnesses for a killable reader. No SQL/bindings/body. */
  onReadStarted?: (event: Omit<SqliteReadDiagnostic, 'elapsedMs' | 'rows'>) => void;
  onReadFinished?: (event: SqliteReadDiagnostic) => void;
  minDurationMs?: number;
  maxReports?: number;
  maxPerCallsite?: number;
  getRequestId?: () => string | null;
  clock?: () => number;
  /** A caller-owned allow-list may describe scalar native input counts, never binding values. */
  describeNativeRead?: (sql: string, bindings: readonly unknown[]) => SqliteNativeReadContext | undefined;
}

/** Bounded native-read witnesses. Binding values, SQL text and row contents never reach the sink. */
export function createSqliteReadDiagnostics(
  options: SqliteReadDiagnosticOptions,
): (db: Database.Database) => () => void {
  const minDurationMs = options.minDurationMs ?? 100;
  const maxReports = options.maxReports ?? 20;
  const maxPerCallsite = options.maxPerCallsite ?? 2;
  const clock = options.clock ?? (() => performance.now());
  const seen = new Map<string, number>();
  const attached = new WeakMap<Database.Database, () => void>();
  const fingerprints = new WeakMap<Database.Statement, string>();
  let reports = 0;
  let observedCalls = 0;

  function safely<T>(run: () => T): T | undefined {
    try {
      return run();
    } catch {
      /* Diagnostic consumers cannot change native results or exceptions. */
    }
  }

  function notify<T>(sink: ((event: T) => void) | undefined, event: T) {
    safely(() => sink?.(event));
  }

  function beginRead(
    db: Database.Database,
    statement: Database.Statement,
    startedAt: number,
    bindings: readonly unknown[],
  ) {
    if ((!options.onReadStarted && !options.onReadFinished) || observedCalls >= maxReports) return;
    observedCalls++;
    return safely(() => {
      const sqlFingerprint = fingerprints.get(statement) ?? createHash('sha256').update(statement.source).digest('hex');
      fingerprints.set(statement, sqlFingerprint);
      const context = safely(() => options.describeNativeRead?.(statement.source, bindings));
      const event = {
        databasePath: db.name,
        sqlFingerprint,
        caller: (new Error().stack ?? '').split('\n').slice(3, 11),
        requestId: options.getRequestId?.() ?? null,
        startedAt,
        ...(context ? { native: { ...context, resourcesBefore: captureNativeReadResources() } } : {}),
      };
      notify(options.onReadStarted, event);
      return event;
    });
  }

  function finishRead(
    db: Database.Database,
    statement: Database.Statement,
    rows: number | null,
    startedAt: number,
    elapsedMs: number,
    witness: ReturnType<typeof beginRead>,
  ) {
    if (witness) {
      const resourcesAfter = witness.native ? captureNativeReadResources() : undefined;
      notify(options.onReadFinished, {
        ...witness,
        elapsedMs,
        rows,
        ...(witness.native
          ? {
              native: {
                ...witness.native,
                resourcesAfter,
                resourceDelta: nativeReadResourceDelta(witness.native.resourcesBefore, resourcesAfter ?? null),
              },
            }
          : {}),
      });
    }
    recordSlowRead(db, statement, rows, startedAt, elapsedMs);
  }

  function recordSlowRead(
    db: Database.Database,
    statement: Database.Statement,
    rows: number | null,
    startedAt: number,
    elapsedMs: number,
  ) {
    if (elapsedMs < minDurationMs || reports >= maxReports) return;
    const fingerprint = fingerprints.get(statement) ?? createHash('sha256').update(statement.source).digest('hex');
    fingerprints.set(statement, fingerprint);
    const caller = (new Error().stack ?? '').split('\n').slice(3, 11);
    const key = `${fingerprint}\n${caller.join('\n')}`;
    const count = seen.get(key) ?? 0;
    if (count >= maxPerCallsite) return;
    seen.set(key, count + 1);
    reports++;
    options.onSlowRead({
      databasePath: db.name,
      sqlFingerprint: fingerprint,
      caller,
      requestId: options.getRequestId?.() ?? null,
      startedAt,
      elapsedMs,
      rows,
    });
  }

  return (db) => {
    const existing = attached.get(db);
    if (existing) return existing;
    const originalPrepare = db.prepare;
    let active = true;
    const observedPrepare = new Proxy(originalPrepare, {
      apply(prepare, receiver, argumentsList) {
        const statement = Reflect.apply(prepare, receiver, argumentsList) as Database.Statement;
        statement.all = new Proxy(statement.all, {
          apply(all, statementReceiver, bindings) {
            if (!active || reports >= maxReports) return Reflect.apply(all, statementReceiver, bindings);
            const startedAt = Date.now();
            const start = clock();
            const witness = beginRead(db, statement, startedAt, bindings);
            let rows: number | null = null;
            try {
              const result: unknown = Reflect.apply(all, statementReceiver, bindings);
              if (Array.isArray(result)) rows = result.length;
              return result;
            } finally {
              // Observability must never replace a native result or exception, including when its sink is down.
              try {
                const elapsedMs = clock() - start;
                finishRead(db, statement, rows, startedAt, elapsedMs, witness);
              } catch {
                /* Keep the original SQLite result/error authoritative. */
              }
            }
          },
        });
        return statement;
      },
    });
    db.prepare = observedPrepare;
    const stop = () => {
      active = false;
      if (db.prepare === observedPrepare) db.prepare = originalPrepare;
      attached.delete(db);
    };
    attached.set(db, stop);
    return stop;
  };
}
