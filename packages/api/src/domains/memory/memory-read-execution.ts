import { randomUUID } from 'node:crypto';
import type { SqliteReadDiagnostic } from '../../infrastructure/sqlite-read-diagnostics.js';
import type { FileVectorReadWindowSnapshot } from './file-vector-read-window.js';
import type { ChildMessage } from './memory-process-protocol.js';
import { MemoryReadTimings } from './memory-read-timings.js';
import { type MessageCandidateAuditSnapshot, safeCandidateAudit } from './message-candidate-audit-wire.js';
import type { CjkReadSnapshot } from './message-cjk-read-diagnostics.js';
import type { VectorSearchDegradeRecord } from './vector-search-degrade-report.js';

export type MemoryReadDiagnostic =
  | { phase: 'database-initialization' }
  | { phase: 'cjk-read'; cjk: CjkReadSnapshot }
  | { phase: 'candidate-audit'; candidateAudit: MessageCandidateAuditSnapshot }
  | { phase: 'read-window-finished'; readWindow: FileVectorReadWindowSnapshot; workerElapsedMs: number }
  | { phase: 'result-ready'; workerElapsedMs: number }
  /** Published by the process pool on receipt; never part of a request's progress. */
  | { phase: 'vector-degrade'; degrade: VectorSearchDegradeRecord }
  | {
      phase: 'sql-start';
      sql: Omit<SqliteReadDiagnostic, 'elapsedMs' | 'rows'>;
      readWindow?: FileVectorReadWindowSnapshot;
    }
  | { phase: 'sql-finish'; sql: SqliteReadDiagnostic };

/** One request's last observed progress, discarded with its Promise; never a work/telemetry ledger. */
export class MemoryReadExecution {
  private readonly executionId = randomUUID();
  private cjk?: CjkReadSnapshot;
  private readWindow?: FileVectorReadWindowSnapshot;
  private candidateAudit?: MessageCandidateAuditSnapshot;
  private readonly submitted = performance.now();
  private readonly timings = new MemoryReadTimings(this.submitted);
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
    if (this.timings.closed) return false;
    if (message.type !== 'embedding' && message.id !== jobId) return message.type === 'read-diagnostic';
    switch (message.type) {
      case 'message-vectors-started':
        this.timings.point('vectorsStarted', message.workerElapsedMs);
        return false;
      case 'read-diagnostic':
        this.observe(message.diagnostic);
        return true;
      case 'started':
        if (message.readWindow) this.readWindow = message.readWindow;
        this.ready();
        return false;
      case 'result':
        if (message.readWindow) this.readWindow = message.readWindow;
        this.timings.mark('resultReceivedMs');
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
    if (this.timings.closed) return;
    if ('readWindow' in event && event.readWindow) this.readWindow = event.readWindow;
    if (event.phase === 'read-window-finished' || event.phase === 'result-ready') {
      this.timings.point(
        event.phase === 'read-window-finished' ? 'scopeEndObservation' : 'resultPrepared',
        event.workerElapsedMs,
      );
      return;
    }
    if (event.phase === 'candidate-audit') {
      this.candidateAudit = safeCandidateAudit(event.candidateAudit);
      return;
    }
    if (event.phase === 'cjk-read') {
      this.cjk = { ...event.cjk };
      return;
    }
    this.phase =
      event.phase === 'sql-start' ? 'sql-read' : event.phase === 'sql-finish' ? 'worker-processing' : event.phase;
    if ('sql' in event) this.observeSql(event);
  }

  private observeSql(event: Extract<MemoryReadDiagnostic, { sql: unknown }>) {
    if (event.phase === 'sql-start' && event.sql.native) this.timings.beginScope();
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

  embeddingStarted(id: number, method: string) {
    if (this.timings.closed) return;
    this.timings.embeddingStarted(id, method);
    this.embeddingId = id;
    this.phase = `embedding-${method}`;
  }

  embeddingFinished(id: number, outcome: 'fulfilled' | 'rejected') {
    if (this.timings.closed) return;
    this.timings.embeddingFinished(id, outcome);
    if (this.embeddingId === id && this.phase.startsWith('embedding-')) this.ready();
  }

  cancelled() {
    this.timings.mark('cancelRequestedMs');
  }

  settled() {
    this.timings.mark('settledMs');
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
      timings: this.timings.snapshot(),
      ...(this.readWindow ? { readWindow: { ...this.readWindow } } : {}),
      ...(outcome === 'fulfilled' && this.candidateAudit ? { candidateAudit: this.candidateAudit } : {}),
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
