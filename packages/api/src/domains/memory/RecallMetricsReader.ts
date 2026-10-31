import { resolve } from 'node:path';
import { runModuleWorker } from '../../utils/run-module-worker.js';
import type { RecallMetricsReport } from './RecallMetricsComputer.js';

export interface RecallMetricsQuery {
  days: number;
  catId?: string;
  toolName?: string;
}

const CACHE_TTL_MS = 60_000;
const MAX_CACHE = 20;
export const RECALL_METRICS_TIMEOUT_MS = 8_000;
let cacheGeneration = 0;

export function clearRecallMetricsCache(): void {
  cacheGeneration++;
}

/** One canonical reader per route registration; each uncached caller owns its job. */
export class RecallMetricsReader {
  private readonly databasePath: string;
  private readonly cache = new Map<string, { report: RecallMetricsReport; expiresAt: number }>();
  private readonly pending = new Map<string, { count: number; committedSequence: number }>();
  private requestSequence = 0;
  private generation = cacheGeneration;

  constructor(
    databasePath: string,
    private readonly timeoutMs = RECALL_METRICS_TIMEOUT_MS,
  ) {
    // A child cannot see an in-memory or temporary connection; never compute on
    // the API thread or copy a database to compensate for an unavailable source.
    this.databasePath = databasePath && databasePath !== ':memory:' ? resolve(databasePath) : '';
  }

  async read(query: RecallMetricsQuery, signal: AbortSignal, refresh = false): Promise<RecallMetricsReport> {
    signal.throwIfAborted();
    if (this.generation !== cacheGeneration) {
      this.cache.clear();
      this.generation = cacheGeneration;
    }
    const key = JSON.stringify(['recall', query.days, query.catId ?? null, query.toolName ?? null]);
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.report;
    if (!this.databasePath) throw new Error('Recall metrics require a file-backed evidence database');

    const generation = this.generation;
    const sequence = ++this.requestSequence;
    const ordering = this.pending.get(key) ?? { count: 0, committedSequence: 0 };
    this.pending.set(key, ordering);
    ordering.count++;
    try {
      const report = await runModuleWorker<RecallMetricsReport>({
        moduleUrl: new URL('./recall-metrics-worker.js', import.meta.url),
        exportName: 'readRecallMetricsInProcess',
        isolation: 'process',
        input: { databasePath: this.databasePath, query, toMs: Date.now() },
        signal,
        // Queue, process startup and computation all consume this budget. The
        // existing executor releases its shared slot only after confirmed exit.
        timeoutMs: this.timeoutMs,
      });
      signal.throwIfAborted();
      if (generation === cacheGeneration && sequence > ordering.committedSequence) {
        // Keep ordering while older jobs remain, even if this key is evicted.
        ordering.committedSequence = sequence;
        if (!this.cache.has(key) && this.cache.size >= MAX_CACHE)
          this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(key, { report, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      return report;
    } finally {
      if (--ordering.count === 0) this.pending.delete(key);
    }
  }
}
