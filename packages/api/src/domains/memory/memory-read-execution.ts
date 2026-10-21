import type { SqliteReadDiagnostic } from '../../infrastructure/sqlite-read-diagnostics.js';
import type { ChildMessage } from './memory-process-protocol.js';

export type MemoryReadDiagnostic =
  | { phase: 'database-initialization' }
  | { phase: 'sql-start'; sql: Omit<SqliteReadDiagnostic, 'elapsedMs' | 'rows'> }
  | { phase: 'sql-finish'; sql: SqliteReadDiagnostic };

/** One request's last observed progress, discarded with its Promise; never a work/telemetry ledger. */
export class MemoryReadExecution {
  private readonly submitted = performance.now();
  private phase = 'queue';
  private pid?: number;
  private queueMs?: number;
  private sqlObservations = 0;
  private observedSqlMs = 0;
  private lastObservedSql?: Record<string, unknown>;
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
    this.phase =
      event.phase === 'sql-start' ? 'sql-read' : event.phase === 'sql-finish' ? 'worker-processing' : event.phase;
    if ('sql' in event) {
      if (event.phase === 'sql-start') this.sqlObservations++;
      if (event.phase === 'sql-finish') this.observedSqlMs += event.sql.elapsedMs;
      this.lastObservedSql = { ...event.sql, event: event.phase, observedAt: Date.now() };
    }
  }

  embeddingStarted(id: number, method: string) {
    this.embeddingId = id;
    this.phase = `embedding-${method}`;
  }

  embeddingFinished(id: number) {
    if (this.embeddingId === id && this.phase.startsWith('embedding-')) this.ready();
  }

  annotate(error: unknown) {
    if (!(error instanceof Error)) return;
    try {
      Object.assign(error, {
        memoryProcess: {
          kind: this.kind,
          pid: this.pid,
          phase: this.phase,
          queueMs: this.queueMs,
          elapsedMs: performance.now() - this.submitted,
          sqlObservations: this.sqlObservations,
          sqlObservationLimit: 20,
          sqlObservationLimitReached: this.sqlObservations >= 20,
          observedSqlMs: this.observedSqlMs,
          lastObservedSql: this.lastObservedSql,
        },
      });
    } catch {
      /* Diagnostics may not replace an immutable original error. */
    }
  }
}
