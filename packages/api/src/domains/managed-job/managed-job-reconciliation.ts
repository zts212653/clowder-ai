import { Worker } from 'node:worker_threads';
import type { ManagedJobHealth } from './managed-job-health.js';
import type { ManagedJobStatusRequest } from './managed-job-status.js';
import type { DurableGateInspection, DurableManagedGateJob, ManagedJobAccess } from './managed-job-types.js';

export interface ManagedJobObservation {
  job: DurableManagedGateJob;
  inspection: DurableGateInspection;
  health: ManagedJobHealth;
  observation: { revision: number; createdAt: number };
}

export type ManagedJobReconciliationRequest = {
  dataRoot: string;
  maxConcurrent: number;
  operatorUserId?: string;
  supervisorEpoch: string;
  now: number;
} & (
  | { kind: 'all'; legacyJobs: readonly DurableManagedGateJob[] }
  | { kind: 'one'; principal: ManagedJobAccess; jobId: string }
  | ({ kind: 'status' } & ManagedJobStatusRequest)
);

/** One existing reconciliation or status read, off the HTTP loop; no scheduling queue or job admission. */
export function reconcileManagedJobsOffLoop<T>(input: ManagedJobReconciliationRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const worker = new Worker(new URL(`../../utils/module-worker.${extension}`, import.meta.url), {
      workerData: {
        moduleUrl: new URL(`./ManagedJobService.${extension}`, import.meta.url).href,
        exportName: 'reconcileManagedJobsInWorker',
        input,
      },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let result:
      | { ok: true; value: T }
      | { ok: false; error: { name: string; message: string; code?: string } }
      | undefined;
    let failure: Error | undefined;
    const budgetMs = { all: 10_000, one: 120_000, status: 15_000 }[input.kind];
    const timer = setTimeout(() => {
      failure = new Error(`Managed job reconciliation exceeded ${budgetMs}ms`);
      void worker.terminate();
    }, budgetMs);
    worker.once('message', (message: typeof result) => {
      result = message;
      void worker.terminate();
    });
    worker.once('error', (error) => {
      failure = error;
      void worker.terminate();
    });
    // A result is not a release receipt: settle only after the worker has exited.
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (!result) reject(new Error(`Managed job reconciliation exited without a result (${code})`));
      else if (result.ok) resolve(result.value);
      else reject(Object.assign(new Error(result.error.message), result.error));
    });
  });
}
