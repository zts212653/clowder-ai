import type {
  TranscriptReadMetrics,
  TranscriptReadObserver,
} from '../domains/cats/services/session/transcript-index/transcript-read-observer.js';
import type { ModuleWorkerTiming } from '../utils/module-worker-timing.js';

export type TranscriptReadStage = 'canonical' | 'generations' | 'files';
export const REQUEST_GENERATIONS_OPERATION = 'GET /api/invocations/:invocationId/request-generations';
interface Options {
  operation?: string;
  onEvent: (event: Record<string, unknown>) => void;
  windowMs?: number;
  maxReports?: number;
  slowMs?: number;
  now?: () => number;
}
function processFields(timing: ModuleWorkerTiming) {
  const metrics = timing.processMetrics;
  if (!metrics) return {};
  return {
    moduleLoadWallMs: metrics.moduleLoadWallMs,
    moduleLoadProcessCpuMs: metrics.moduleLoadProcessCpuMs,
    operationStarted: metrics.operationStarted,
    operationWallMs: metrics.operationWallMs,
    operationProcessCpuMs: metrics.operationProcessCpuMs,
    // Startup, IPC/serialization and parent scheduling remain combined here.
    parentResidualMs: timing.runMs - metrics.moduleLoadWallMs - metrics.operationWallMs,
  };
}

/** Explicit callers opt in; no ALS/request slots or payload retention. */
export function createTranscriptReadDiagnostics(options: Options) {
  const operation = options.operation ?? REQUEST_GENERATIONS_OPERATION;
  const now = options.now ?? performance.now.bind(performance);
  const startedAt = now();
  const windowMs = options.windowMs ?? 15 * 60_000;
  const maxReports = options.maxReports ?? 64;
  const slowMs = options.slowMs ?? 100;
  let stopped = false;
  let sequence = 0;
  const coverage = {
    observedReads: 0,
    completedReads: 0,
    failedReads: 0,
    abortedReads: 0,
    rows: 0,
    sourceBytesScanned: 0,
    hydratedBytes: 0,
    summaryCacheHits: 0,
    prepareMs: 0,
    workerAwaitMs: 0,
    materializeMs: 0,
    settledWorkers: 0,
    settledStartedWorkers: 0,
    releasedWorkers: 0,
    queueMs: 0,
    runMs: 0,
    releaseLagMs: 0,
    reportedReads: 0,
    droppedReads: 0,
    reportedWorkers: 0,
    droppedWorkers: 0,
    processMeasuredWorkers: 0,
    moduleLoadWallMs: 0,
    moduleLoadProcessCpuMs: 0,
    operationWallMs: 0,
    operationProcessCpuMs: 0,
  };
  const emit = (event: Record<string, unknown>) => {
    try {
      options.onEvent(event);
    } catch {
      /* Logging must not break reads. */
    }
  };
  const addProcessWork = (timing: ModuleWorkerTiming) => {
    const metrics = timing.processMetrics;
    if (!metrics) return;
    ++coverage.processMeasuredWorkers;
    coverage.moduleLoadWallMs += metrics.moduleLoadWallMs;
    coverage.moduleLoadProcessCpuMs += metrics.moduleLoadProcessCpuMs;
    coverage.operationWallMs += metrics.operationWallMs;
    coverage.operationProcessCpuMs += metrics.operationProcessCpuMs;
  };
  const stop = (reason: 'window' | 'close' = 'close') => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    emit({
      type: 'transcript_read_coverage_end',
      operation,
      reason,
      elapsedMs: now() - startedAt,
      ...coverage,
      incompleteReads: coverage.observedReads - coverage.completedReads,
      settledWithoutRelease: coverage.settledStartedWorkers - coverage.releasedWorkers,
      processMeasurementMissingWorkers: coverage.settledStartedWorkers - coverage.processMeasuredWorkers,
    });
  };
  const timer = setTimeout(() => stop('window'), windowMs);
  timer.unref();
  const isActive = () => {
    if (!stopped && now() - startedAt >= windowMs) stop('window');
    return !stopped;
  };
  const admitReport = (kind: 'Reads' | 'Workers') => {
    const reported = kind === 'Reads' ? 'reportedReads' : 'reportedWorkers';
    const dropped = kind === 'Reads' ? 'droppedReads' : 'droppedWorkers';
    if (coverage[reported] >= maxReports) {
      ++coverage[dropped];
      return false;
    }
    ++coverage[reported];
    return true;
  };
  const beginRead = (requestId: string, stage: TranscriptReadStage): TranscriptReadObserver | undefined => {
    if (!isActive()) return undefined;
    ++coverage.observedReads;
    const readSequence = ++sequence; // server-local; repeated client request-id values do not merge reads
    let completed = false;
    const identity = { operation, requestId, stage, readSequence };
    return {
      onRead(metrics: TranscriptReadMetrics) {
        if (completed || !isActive()) return;
        completed = true;
        ++coverage.completedReads;
        coverage.failedReads += Number(metrics.status === 'failed');
        coverage.abortedReads += Number(metrics.status === 'aborted');
        coverage.rows += metrics.rows;
        coverage.sourceBytesScanned += metrics.sourceBytesScanned;
        coverage.hydratedBytes += metrics.hydratedBytes;
        coverage.summaryCacheHits += metrics.summaryCacheHits;
        coverage.prepareMs += metrics.prepareMs;
        coverage.workerAwaitMs += metrics.workerAwaitMs;
        coverage.materializeMs += metrics.materializeMs;
        if (metrics.elapsedMs < slowMs && metrics.status === 'success') return;
        if (!admitReport('Reads')) return;
        emit({
          type: 'transcript_read',
          ...identity,
          status: metrics.status,
          sessionCount: metrics.sessionCount,
          rows: metrics.rows,
          prepareMs: metrics.prepareMs,
          workerAwaitMs: metrics.workerAwaitMs,
          materializeMs: metrics.materializeMs,
          elapsedMs: metrics.elapsedMs,
          sourceBytesScanned: metrics.sourceBytesScanned,
          hydratedBytes: metrics.hydratedBytes,
          summaryCacheHits: metrics.summaryCacheHits,
        });
      },
      onWorkerTiming(timing: ModuleWorkerTiming) {
        if (!isActive()) return;
        if (timing.phase === 'settled') {
          ++coverage.settledWorkers;
          coverage.settledStartedWorkers += Number(timing.started);
          coverage.queueMs += timing.queueMs;
          coverage.runMs += timing.runMs;
          addProcessWork(timing);
        } else {
          ++coverage.releasedWorkers;
          coverage.releaseLagMs += timing.releaseLagMs;
        }
        if (timing.elapsedMs < slowMs && timing.outcome === 'success') return;
        if (!admitReport('Workers')) return;
        emit({
          type: 'transcript_worker',
          ...identity,
          phase: timing.phase,
          outcome: timing.outcome,
          started: timing.started,
          elapsedMs: timing.elapsedMs,
          queueMs: timing.queueMs,
          runMs: timing.runMs,
          releaseLagMs: timing.releaseLagMs,
          activeAtAdmission: timing.activeAtAdmission,
          queuedAtAdmission: timing.queuedAtAdmission,
          ...processFields(timing),
        });
      },
    };
  };
  return { beginRead, stop };
}
