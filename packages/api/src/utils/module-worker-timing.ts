export interface ModuleProcessMetrics {
  /** Import of the trusted target module, after the child receives its one job. */
  moduleLoadWallMs: number;
  /** Total child process CPU in that interval, including its background threads. */
  moduleLoadProcessCpuMs: number;
  operationStarted: boolean;
  /** Export call, including any lazy imports and async waits inside it. */
  operationWallMs: number;
  operationProcessCpuMs: number;
}

export interface ModuleWorkerTiming {
  phase: 'settled' | 'released';
  outcome: 'success' | 'failed' | 'aborted' | 'timeout' | 'rejected';
  started: boolean;
  elapsedMs: number;
  /** Admission to start; includes scheduling delay, not the worker's own execution. */
  queueMs: number;
  /** Start to settlement (spawn/import, work, serialization and IPC); not CPU time. */
  runMs: number;
  /** Settlement to actual exit/capacity release. Zero at settlement. */
  releaseLagMs: number;
  activeAtAdmission: number;
  queuedAtAdmission: number;
  /** Absent for threads, pre-result cancellation, or failed CPU measurement. Not zero CPU. */
  processMetrics?: ModuleProcessMetrics;
}
