import { setTimeout } from 'node:timers/promises';
import { readDurableGateRecovery } from '../ball-custody/durable-managed-gate-recovery.js';
import type { ManagedJobService } from './ManagedJobService.js';
import { isManagedJobStoreBusy, withSupervisorStores } from './managed-job-database.js';
import type { ManagedJobAccess } from './managed-job-types.js';

export interface ManagedJobStatusRequest {
  principal: ManagedJobAccess;
  jobId: string;
  tailBytes?: number;
  gateRecovery?: boolean;
}

export type ManagedJobStatusSnapshot = Awaited<ReturnType<typeof readStatusSnapshot>>;

/** Called only in the existing managed-job worker. No admission, execution or recovery mutation. */
function readStatusSnapshot(service: ManagedJobService, input: ManagedJobStatusRequest) {
  const status = service.get(input.principal, input.jobId);
  const job = service.resolve(input.jobId);
  if (!job) throw new Error('managed_job_not_found');
  return {
    job,
    status,
    ...(input.tailBytes === undefined
      ? {}
      : {
          tail: service.tail(input.principal, input.jobId, input.tailBytes),
          transitions: service.transitions(input.principal, input.jobId),
        }),
    ...(input.gateRecovery && ['resumable_full_gate_v2', 'alpha_revision_v1'].includes(job.kind)
      ? { recoveryBlockedReason: readDurableGateRecovery(job, 50)?.blockReason }
      : {}),
  };
}

/** One bounded observation of the same principal/job. Only SQLITE_BUSY permits another read attempt. */
export async function readManagedJobStatus(
  service: ManagedJobService,
  input: ManagedJobStatusRequest,
): Promise<ManagedJobStatusSnapshot> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    try {
      return await withSupervisorStores(async () => readStatusSnapshot(service, input), 50);
    } catch (error) {
      const remainingMs = deadline - performance.now();
      if (!isManagedJobStoreBusy(error) || remainingMs <= 0) throw error;
      // The failed operation's connections have closed before the next attempt.
      await setTimeout(Math.min(50, remainingMs));
    }
  }
}
