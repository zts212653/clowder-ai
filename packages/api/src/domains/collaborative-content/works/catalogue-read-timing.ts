import { performance } from 'node:perf_hooks';

export type WorkReadPhase =
  | 'admission'
  | 'discovery'
  | 'visibility'
  | 'selectedVersions'
  | 'manifestValidation'
  | 'finalAuthorization';

/** Wall time only; nested consumer work and external waits are not CPU attribution. */
export interface WorkCatalogueReadTiming {
  outcome: 'success' | 'failed';
  elapsedMs: number;
  phases: Record<WorkReadPhase, number>;
  /** Process main-loop activity during this read; not request CPU or filesystem service time. */
  mainLoop: { activeMs: number; idleMs: number; utilization: number };
  counts: { pages: number; heads: number; selectedVersions: number; returned: number };
}

export type WorkCatalogueReadObserver = (report: WorkCatalogueReadTiming) => void;

/** One fixed-size report per request, containing no authority inputs or retained source objects. */
export function createWorkCatalogueReadTiming(observer?: WorkCatalogueReadObserver) {
  const started = performance.now();
  const loopAtStart = observer ? performance.eventLoopUtilization() : undefined;
  const phases: WorkCatalogueReadTiming['phases'] = {
    admission: 0,
    discovery: 0,
    visibility: 0,
    selectedVersions: 0,
    manifestValidation: 0,
    finalAuthorization: 0,
  };
  const counts = { pages: 0, heads: 0, selectedVersions: 0, returned: 0 };
  return {
    counts,
    async measure<T>(phase: WorkReadPhase, read: () => Promise<T>): Promise<T> {
      if (!observer) return read();
      const before = performance.now();
      try {
        return await read();
      } finally {
        phases[phase] += performance.now() - before;
      }
    },
    finish(outcome: WorkCatalogueReadTiming['outcome']) {
      try {
        if (!observer || !loopAtStart) return;
        const loop = performance.eventLoopUtilization(loopAtStart);
        observer({
          outcome,
          elapsedMs: performance.now() - started,
          phases: { ...phases },
          counts: { ...counts },
          mainLoop: { activeMs: loop.active, idleMs: loop.idle, utilization: loop.utilization },
        });
      } catch {
        /* Observation cannot replace the original result or failure. */
      }
    },
  };
}
