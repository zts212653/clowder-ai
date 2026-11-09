import type { MemoryReadSnapshot } from './memory-read-execution.js';
import { MessageSearchCandidateDiagnostics } from './message-search-candidate-diagnostics.js';
import { privateMessageSearchTrace } from './message-search-trace.js';

type Operation = 'source' | 'thread' | 'access' | 'state' | 'projection';
const counter = () => ({ started: 0, fulfilled: 0, rejected: 0, elapsedMs: 0 });

/** Fixed-size, request-local observations. Sums include overlapping async wall waits, not exclusive CPU/I/O. */
export class MessageSearchDiagnostics {
  private active = true;
  private readonly workers: MemoryReadSnapshot[] = [];
  private readonly operations = {
    source: counter(),
    thread: counter(),
    access: counter(),
    state: counter(),
    projection: counter(),
  };
  private readonly waves = { ...counter(), maxWidth: 0, candidates: 0 };
  private acceptedRows = 0;
  private inputCandidates: number | null = null;
  private traceEvents = 0;

  readonly candidateEvidence?: MessageSearchCandidateDiagnostics;

  constructor(
    private readonly sink?: (trace: Record<string, unknown>) => void,
    scope?: { searchId: string; ownerId: string },
  ) {
    if (scope) this.candidateEvidence = new MessageSearchCandidateDiagnostics(scope.searchId, scope.ownerId, sink);
  }

  readonly trace = (trace: Record<string, unknown>) => {
    if (!this.active || this.traceEvents >= 32) return;
    const safe = privateMessageSearchTrace(trace);
    if (!safe) return;
    this.traceEvents++;
    if (safe.phase === 'retrieval' || safe.phase === 'canonical-projection') Object.assign(safe, this.snapshot());
    try {
      this.sink?.(safe);
    } catch {
      /* Private observers cannot alter search semantics. */
    }
  };

  readonly worker = (snapshot: MemoryReadSnapshot) => {
    if (!this.active) return;
    this.candidateEvidence?.worker(snapshot);
    // Full evidence is published once after host admission; ordinary traces/errors remain small.
    const { candidateAudit: _candidateAudit, ...summary } = snapshot;
    const index = this.workers.findIndex((row) => row.executionId === snapshot.executionId);
    if (index >= 0) this.workers[index] = summary;
    else if (this.workers.length < 2) this.workers.push(summary); // Initial read plus existing retirement fallback.
  };

  async measure<T>(name: Operation, run: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    if (this.active) this.operations[name].started++;
    try {
      const value = await run();
      if (this.active) this.operations[name].fulfilled++;
      return value;
    } catch (error) {
      if (this.active) this.operations[name].rejected++;
      throw error;
    } finally {
      if (this.active) this.operations[name].elapsedMs += performance.now() - start;
    }
  }

  sync<T>(name: Operation, run: () => T): T {
    const start = performance.now();
    if (this.active) this.operations[name].started++;
    try {
      const value = run();
      if (this.active) this.operations[name].fulfilled++;
      return value;
    } catch (error) {
      if (this.active) this.operations[name].rejected++;
      throw error;
    } finally {
      if (this.active) this.operations[name].elapsedMs += performance.now() - start;
    }
  }

  async wave<T>(width: number, run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    if (this.active) {
      this.waves.started++;
      this.waves.maxWidth = Math.max(this.waves.maxWidth, width);
      this.waves.candidates += width;
    }
    try {
      const value = await run();
      if (this.active) this.waves.fulfilled++;
      return value;
    } catch (error) {
      if (this.active) this.waves.rejected++;
      throw error;
    } finally {
      if (this.active) this.waves.elapsedMs += performance.now() - start;
    }
  }

  candidates(count: number) {
    if (this.active) this.inputCandidates = count;
  }

  accepted() {
    if (this.active) this.acceptedRows++;
  }

  snapshot() {
    return {
      workerReads: [...this.workers],
      workerReadLimit: 2,
      canonical: {
        waves: { ...this.waves },
        operations: Object.fromEntries(Object.entries(this.operations).map(([key, value]) => [key, { ...value }])),
        acceptedRows: this.acceptedRows,
        inputCandidates: this.inputCandidates,
      },
    };
  }

  close() {
    this.active = false;
    this.candidateEvidence?.close();
    this.workers.length = 0;
  }
}
