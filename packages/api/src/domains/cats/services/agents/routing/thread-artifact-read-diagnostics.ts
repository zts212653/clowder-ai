import type { FastifyBaseLogger } from 'fastify';
import { observeSlowReadCpu } from '../../../../../infrastructure/slow-read-cpu-observer.js';
import type {
  WorkCatalogueReadObserver,
  WorkCatalogueReadTiming,
} from '../../../../collaborative-content/works/catalogue-read-timing.js';

type Stage =
  | 'messages'
  | 'tasks'
  | 'memory'
  | 'liveFiles'
  | 'acceptedFiles'
  | 'prTitles'
  | 'independentWorks'
  | 'lineage';

/** Stage wall time is not CPU time. Retain no messages, source coordinates or error payloads. */
export async function observeThreadArtifactRead<T>(
  logger: Pick<FastifyBaseLogger, 'info'>,
  read: (
    measure: <R>(stage: Stage, operation: () => R | Promise<R>) => Promise<R>,
    recordWorkRead: WorkCatalogueReadObserver,
  ) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const finishCpuObservation = observeSlowReadCpu(logger);
  const stages: Partial<Record<Stage, number>> = {};
  let independentWorkRead: WorkCatalogueReadTiming | undefined;
  let status = 'failed';
  try {
    const result = await read(
      async (stage, operation) => {
        const before = performance.now();
        try {
          return await operation();
        } finally {
          stages[stage] = (stages[stage] ?? 0) + performance.now() - before;
        }
      },
      (report) => {
        independentWorkRead = copyWorkTiming(report);
      },
    );
    status = 'success';
    return result;
  } finally {
    finishCpuObservation();
    const handlerElapsedMs = performance.now() - started;
    if (handlerElapsedMs >= 1000) {
      try {
        logger.info(
          { handlerElapsedMs, stages, status, ...(independentWorkRead ? { independentWorkRead } : {}) },
          '[Task229] thread artifact read diagnostic',
        );
      } catch {
        /* Diagnostics must not replace the read result or failure. */
      }
    }
  }
}

/** Copy the fixed numeric schema; do not retain arbitrary objects supplied by a port. */
function copyWorkTiming(report: WorkCatalogueReadTiming): WorkCatalogueReadTiming | undefined {
  const phases = {
    admission: report.phases.admission,
    discovery: report.phases.discovery,
    visibility: report.phases.visibility,
    selectedVersions: report.phases.selectedVersions,
    manifestValidation: report.phases.manifestValidation,
    finalAuthorization: report.phases.finalAuthorization,
  };
  const mainLoop = {
    activeMs: report.mainLoop.activeMs,
    idleMs: report.mainLoop.idleMs,
    utilization: report.mainLoop.utilization,
  };
  const counts = {
    pages: report.counts.pages,
    heads: report.counts.heads,
    selectedVersions: report.counts.selectedVersions,
    returned: report.counts.returned,
  };
  if (report.outcome !== 'success' && report.outcome !== 'failed') return undefined;
  if (
    ![report.elapsedMs, ...Object.values(phases), ...Object.values(counts), ...Object.values(mainLoop)].every(
      (n) => Number.isFinite(n) && n >= 0,
    )
  )
    return undefined;
  return { outcome: report.outcome, elapsedMs: report.elapsedMs, phases, counts, mainLoop };
}
