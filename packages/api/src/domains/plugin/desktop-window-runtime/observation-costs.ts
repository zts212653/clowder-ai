import {
  type ClockPoint,
  MAX_WORK_MS,
  type ObservationWorkSummary,
  type SealCaller,
  type SealReadDiagnostics,
  type SealReadSummary,
  type SnapshotReadDiagnostics,
  sealCaller,
  workMs,
} from '../diagnostics/observation-work.js';

const point = (wall: number): ClockPoint => ({ wallMs: Math.round(wall), monotonicMs: Math.round(performance.now()) });
const signedMs = (value: number) => Math.max(-MAX_WORK_MS, Math.min(MAX_WORK_MS, value));

/** One Host call owns these fixed summaries. Successful calls leave no retained history. */
export class ObservationCosts {
  private readonly caller: SealCaller;
  private readonly reads = { queueMs: 0, readMs: 0, parseMs: 0, cloneMs: 0 };
  private readObserved = false;
  private seal?: SealReadSummary;
  private received?: ClockPoint;
  private refreshed?: ClockPoint;
  private published?: ClockPoint;

  constructor(caller: SealCaller) {
    this.caller = sealCaller(caller);
  }

  readonly snapshotDiagnostics: SnapshotReadDiagnostics = {
    measure: async <T>(stage: 'queue' | 'read', work: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      this.readObserved = true;
      try {
        return await work();
      } finally {
        this.reads[`${stage}Ms`] = workMs(performance.now() - start);
      }
    },
    sync: <T>(stage: 'parse' | 'clone', work: () => T): T => {
      const start = performance.now();
      this.readObserved = true;
      try {
        return work();
      } finally {
        this.reads[`${stage}Ms`] = workMs(performance.now() - start);
      }
    },
  };

  get packageDiagnostics(): SealReadDiagnostics {
    return {
      caller: this.caller,
      record: (summary) => {
        this.seal = summary;
      },
    };
  }

  receive(wallMs: number): void {
    this.received = point(wallMs);
  }

  refresh(wallMs: number): void {
    this.refreshed = point(wallMs);
  }

  publish(wallMs: number): void {
    this.published = point(wallMs);
  }

  snapshot(): ObservationWorkSummary {
    const received = this.received;
    const published = this.published;
    const wallElapsed = received && published ? published.wallMs - received.wallMs : 0;
    const monotonicElapsed = received && published ? published.monotonicMs - received.monotonicMs : 0;
    const drift = wallElapsed - monotonicElapsed;
    return structuredClone({
      caller: this.caller,
      ...(this.readObserved ? { snapshot: this.reads } : {}),
      ...(this.seal ? { seal: this.seal } : {}),
      ...(received && published
        ? {
            clock: {
              received,
              ...(this.refreshed ? { refreshed: this.refreshed } : {}),
              published,
              wallElapsedMs: signedMs(wallElapsed),
              monotonicElapsedMs: workMs(monotonicElapsed),
              wallMinusMonotonicMs: signedMs(drift),
              capped:
                Math.abs(wallElapsed) > MAX_WORK_MS ||
                monotonicElapsed < 0 ||
                monotonicElapsed > MAX_WORK_MS ||
                Math.abs(drift) > MAX_WORK_MS,
            },
          }
        : {}),
    });
  }
}
