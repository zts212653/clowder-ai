import { randomUUID } from 'node:crypto';
import type { SqliteReadDiagnostic } from '../../infrastructure/sqlite-read-diagnostics.js';
import type { ChildMessage } from './memory-process-protocol.js';
import type { CjkReadSnapshot } from './message-cjk-read-diagnostics.js';

export type MemoryReadDiagnostic =
  | { phase: 'database-initialization' }
  | { phase: 'cjk-read'; cjk: CjkReadSnapshot }
  | { phase: 'sql-start'; sql: Omit<SqliteReadDiagnostic, 'elapsedMs' | 'rows'> }
  | { phase: 'sql-finish'; sql: SqliteReadDiagnostic };

/** One request's last observed progress, discarded with its Promise; never a work/telemetry ledger. */
export class MemoryReadExecution {
  private readonly executionId = randomUUID();
  private cjk?: CjkReadSnapshot;
  private readonly submitted = performance.now();
  private phase = 'queue';
  private pid?: number;
  private queueMs?: number;
  private sqlObservations = 0;
  private observedSqlMs = 0;
  private lastObservedSql?: Record<string, unknown>;
  private nativeVectorRead?: {
    sqlFingerprint: string;
    startedAt: number;
    observedAt: number;
    event: 'sql-start' | 'sql-finish';
    /** Producer monotonic wrapper duration; absent until sql-finish, distinct from parent receipt time. */
    elapsedMs?: number;
    native: NonNullable<SqliteReadDiagnostic['native']>;
  };
  private embeddingId?: number;

  constructor(private readonly kind: 'search' | 'message-search') {}

  onMessage(message: ChildMessage, jobId: number): boolean {
    switch (message.type) {
      case 'read-diagnostic':
        if (message.id === jobId) this.observe(message.diagnostic);
        return true;
      case 'started':
        if (message.id === jobId) this.ready();
        return false;
      case 'embedding':
        this.embeddingStarted(message.id, message.method);
        return false;
      default:
        return false;
    }
  }

  dispatched(pid: number | undefined) {
    this.pid = pid;
    this.queueMs = performance.now() - this.submitted;
    this.phase = 'worker-startup';
  }

  ready() {
    this.phase = 'worker-processing';
  }

  observe(event: MemoryReadDiagnostic) {
    if (event.phase === 'cjk-read') {
      this.cjk = { ...event.cjk };
      return;
    }
    this.phase =
      event.phase === 'sql-start' ? 'sql-read' : event.phase === 'sql-finish' ? 'worker-processing' : event.phase;
    if ('sql' in event) {
      if (event.phase === 'sql-start') this.sqlObservations++;
      if (event.phase === 'sql-finish') this.observedSqlMs += event.sql.elapsedMs;
      this.lastObservedSql = { ...event.sql, event: event.phase, observedAt: Date.now() };
      if (event.sql.native)
        this.nativeVectorRead = {
          sqlFingerprint: event.sql.sqlFingerprint,
          startedAt: event.sql.startedAt,
          observedAt: Date.now(),
          event: event.phase,
          ...(event.phase === 'sql-finish' ? { elapsedMs: event.sql.elapsedMs } : {}),
          native: event.sql.native,
        };
    }
  }

  embeddingStarted(id: number, method: string) {
    this.embeddingId = id;
    this.phase = `embedding-${method}`;
  }

  embeddingFinished(id: number) {
    if (this.embeddingId === id && this.phase.startsWith('embedding-')) this.ready();
  }

  snapshot(outcome: 'pending' | 'fulfilled' | 'rejected') {
    return {
      executionId: this.executionId,
      kind: this.kind,
      pid: this.pid,
      outcome,
      phase: this.phase,
      queueMs: this.queueMs,
      elapsedMs: performance.now() - this.submitted,
      sqlObservations: this.sqlObservations,
      sqlObservationLimit: 20,
      sqlObservationLimitReached: this.sqlObservations >= 20,
      observedSqlMs: this.observedSqlMs,
      lastObservedSql: this.lastObservedSql,
      nativeVectorRead: this.nativeVectorRead ?? null,
      cjk: this.cjk ? { ...this.cjk } : null,
    };
  }

  annotate(error: unknown) {
    if (!(error instanceof Error)) return;
    try {
      Object.assign(error, { memoryProcess: this.snapshot('rejected') });
    } catch {
      /* Diagnostics may not replace an immutable original error. */
    }
  }
}

export type MemoryReadSnapshot = ReturnType<MemoryReadExecution['snapshot']>;
