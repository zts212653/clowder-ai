/** Private Host diagnostics only; no package/renderer authority or public bridge fields. */
export type SealCaller = 'observer' | 'presence' | 'other';
export interface SnapshotReadDiagnostics {
  measure<T>(stage: 'queue' | 'read', work: () => Promise<T>): Promise<T>;
  sync<T>(stage: 'parse' | 'clone', work: () => T): T;
}
export interface SealReadSummary {
  readonly caller: SealCaller;
  readonly callers: readonly SealCaller[];
  readonly consumerPeak: number;
  /** Same-generation slot occupancy sampled at this consumer's own dispatches. */
  readonly ioPeak: number;
  readonly lstatCalls: number;
  readonly readdirCalls: number;
  /** Inclusive per-operation totals overlap across concurrent reads; not disk/lock attribution. */
  readonly queueWaitMs: number;
  readonly maxQueueWaitMs: number;
  readonly ioAwaitMs: number;
  readonly maxIoAwaitMs: number;
  readonly capped: boolean;
}
export interface SealReadDiagnostics {
  readonly caller: SealCaller;
  record(summary: SealReadSummary): void;
}
export interface ClockPoint {
  readonly wallMs: number;
  readonly monotonicMs: number;
}
export interface ObservationWorkSummary {
  readonly caller: SealCaller;
  readonly snapshot?: Readonly<Record<'queueMs' | 'readMs' | 'parseMs' | 'cloneMs', number>>;
  readonly seal?: SealReadSummary;
  readonly clock?: {
    readonly received: ClockPoint;
    readonly published: ClockPoint;
    readonly wallElapsedMs: number;
    readonly monotonicElapsedMs: number;
    readonly wallMinusMonotonicMs: number;
    readonly capped: boolean;
  };
}
export const MAX_WORK_MS = 86_400_000;
export const MAX_WORK_COUNT = 65_535;
export const sealCaller = (value: SealCaller): SealCaller =>
  value === 'observer' || value === 'presence' ? value : 'other';
export const workMs = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(MAX_WORK_MS, Math.round(value))) : MAX_WORK_MS;
