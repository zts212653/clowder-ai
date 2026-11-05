import { cleanupDurableManagedGateAttempt } from '../../infrastructure/managed-runner-durable-attempt.js';
import { readUnixProcessSnapshotSync, sameUnixProcess } from '../../utils/cli-process-ownership.js';
import { inspectDurableManagedGateJob } from './durable-managed-gate-job.js';
import {
  rawDurableGateRecord,
  readDurableGateRecord,
  writeDurableGateRecord,
} from './durable-managed-gate-job-store.js';
import { collectManagedJobHealth } from './managed-job-health.js';
import { readManagedJobTransitions } from './managed-job-ledger.js';
import type { ManagedJobObservation } from './managed-job-reconciliation.js';
import type { DurableManagedGateJob } from './managed-job-types.js';

/** Existing fenced recovery, performed in the worker under the API's epoch. */
export async function reconcileManagedJobDescriptor(
  job: DurableManagedGateJob,
  now: number,
  supervisorEpoch: string,
): Promise<ManagedJobObservation> {
  const record = readDurableGateRecord(job);
  if (record?.state !== 'terminal' && record?.ownerIdentity && record.attemptToken && !record.cleanupProven) {
    const snapshot = readUnixProcessSnapshotSync({ pids: [record.ownerIdentity.pid] });
    if (snapshot !== null && !sameUnixProcess(record.ownerIdentity, snapshot.get(record.ownerIdentity.pid))) {
      const cleanup = await cleanupDurableManagedGateAttempt(record.attemptToken, 3000, 100);
      if (cleanup.proven)
        writeDurableGateRecord(
          { ...job, supervisorEpoch },
          { ...rawDurableGateRecord(job), cleanupProven: true, updatedAt: Date.now() },
        );
    }
  }
  const inspection = inspectDurableManagedGateJob(job, { now, supervisorEpoch });
  const history =
    job.recordStorage === 'sqlite_v1' ? readManagedJobTransitions(job) : [rawDurableGateRecord(job) ?? {}];
  const health = collectManagedJobHealth(job, inspection, history, now);
  const latest = history.at(-1) ?? {};
  return {
    job,
    inspection,
    health,
    observation: {
      revision: Number(latest.revision) || Number(latest.updatedAt) || 0,
      createdAt: Number(latest.createdAt) || 0,
    },
  };
}
