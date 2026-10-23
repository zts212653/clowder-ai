import type { ModuleWorkerTiming } from '../../../../../utils/module-worker-timing.js';
import type { InvocationIndexDiagnostics } from './transcript-invocation-index-types.js';

export interface TranscriptReadMetrics extends InvocationIndexDiagnostics {
  status: 'success' | 'failed' | 'aborted';
  sessionCount: number;
  rows: number;
  prepareMs: number;
  /** Includes pool queue, spawn/import, worker execution and IPC. Not file/SQLite time. */
  workerAwaitMs: number;
  materializeMs: number;
  elapsedMs: number;
}

export interface TranscriptReadObserver {
  onRead: (metrics: TranscriptReadMetrics) => void;
  onWorkerTiming: (timing: ModuleWorkerTiming) => void;
}

export function createTranscriptReadMetrics(sessionCount: number): TranscriptReadMetrics {
  return {
    status: 'failed',
    sessionCount,
    rows: 0,
    prepareMs: 0,
    workerAwaitMs: 0,
    materializeMs: 0,
    elapsedMs: 0,
    sourceBytesScanned: 0,
    hydratedBytes: 0,
    summaryCacheHits: 0,
  };
}

export function notifyTranscriptRead(observer: TranscriptReadObserver | undefined, metrics: TranscriptReadMetrics) {
  try {
    observer?.onRead(metrics);
  } catch {
    // Result and original errors take precedence over diagnostics.
  }
}
