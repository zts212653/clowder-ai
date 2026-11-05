import { createModuleLogger } from '../../infrastructure/logger.js';
import { readUnixProcessSnapshotSync, sameUnixProcess } from '../../utils/cli-process-ownership.js';
import { rawDurableGateRecord } from './durable-managed-gate-job-store.js';
import { validateDurableManagedGateJob } from './durable-managed-gate-job-validation.js';
import { observeManagedJobTransition } from './managed-job-health.js';
import { reconcileManagedJobDescriptor } from './managed-job-reconcile-descriptor.js';
import type { ManagedJobObservation } from './managed-job-reconciliation.js';
import {
  type ManagedJobRecoveryRow,
  readManagedJobRecovery,
  updateManagedJobRecovery,
} from './managed-job-recovery-ledger.js';
import {
  applyManagedJobRecoveryOutcome,
  type ManagedJobRecoveryFact,
  type ManagedJobRecoveryOutcome,
} from './managed-job-recovery-state.js';
import type { DurableManagedGateJob } from './managed-job-types.js';

const log = createModuleLogger('managed-job/recovery');

function observationOutcome(row: ManagedJobObservation): ManagedJobRecoveryOutcome {
  if ('result' in row.inspection) return { kind: 'waiting' }; // Delivery, not inspection, acknowledges the intent.
  const record = row.inspection.record;
  if (record?.ownerIdentity && record.attemptToken && !record.cleanupProven) {
    const snapshot = readUnixProcessSnapshotSync({ pids: [record.ownerIdentity.pid] });
    if (snapshot === null) return { kind: 'retryable_error', reason: 'process_observation_unavailable' };
    if (!sameUnixProcess(record.ownerIdentity, snapshot.get(record.ownerIdentity.pid)))
      return { kind: 'retryable_error', reason: 'cleanup_unproven' };
  }
  return { kind: 'waiting' };
}

/** One owner row owns its error budget; a malformed neighbour cannot abort the whole batch. */
export async function reconcileManagedJobDueRow(
  selected: ManagedJobRecoveryRow,
  locator: DurableManagedGateJob,
  dataRoot: string,
  now: number,
  supervisorEpoch: string,
): Promise<ManagedJobObservation | null> {
  if (selected.recovery.disposition) return null;
  const job = selected.record.descriptor as DurableManagedGateJob | undefined;
  if (!job || job.jobId !== selected.jobId || !validateDurableManagedGateJob(job, job.originTaskId, dataRoot)) {
    updateManagedJobRecovery({ ...locator, jobId: selected.jobId }, selected.revision, {
      ...applyManagedJobRecoveryOutcome(
        selected.recovery,
        { kind: 'permanent_error', reason: 'invalid_job_descriptor' },
        selected.jobId,
        now,
      ),
      nextAttemptAt: null,
    });
    return null;
  }
  // Parked owners can deliver their notification, but never re-enter execution recovery automatically.
  const { claim: expiredClaim, ...unclaimed } = selected.recovery;
  if (expiredClaim) {
    updateManagedJobRecovery(
      job,
      selected.revision,
      applyManagedJobRecoveryOutcome(
        unclaimed,
        { kind: 'retryable_error', reason: 'observation_interrupted' },
        job.jobId,
        now,
      ),
    );
    return null;
  }
  if (
    !updateManagedJobRecovery(job, selected.revision, {
      ...unclaimed,
      claim: { expiresAt: now + 10_000 },
      nextAttemptAt: now + 10_000,
    })
  )
    return null;
  const claimRevision = selected.revision + 1;
  try {
    const row = await reconcileManagedJobDescriptor(job, now, supervisorEpoch);
    const current = readManagedJobRecovery(job);
    if (!current || current.revision !== claimRevision) return row;
    // A supervisor may have committed a new terminal/observation fact during this read.
    // Re-read that exact owner; never overwrite its new intent with the old candidate's metadata.
    const latest = rawDurableGateRecord(job);
    const revision = Number(latest?.revision) || 0;
    const { claim: _claim, ...released } = current.recovery;
    let recovery: ManagedJobRecoveryFact = { ...released, nextAttemptAt: now + 30_000 };
    if (current.record.state !== 'terminal')
      recovery = applyManagedJobRecoveryOutcome(recovery, observationOutcome(row), job.jobId, now);
    const transition = recovery.observedRevision !== revision;
    recovery = { ...recovery, observedRevision: revision };
    if (updateManagedJobRecovery(job, current.revision, recovery) && transition)
      observeManagedJobTransition(job, revision, row.inspection.state);
    return row;
  } catch (error) {
    // Preserve the original business record and any pending result; only owner recovery facts advance.
    updateManagedJobRecovery(
      job,
      claimRevision,
      applyManagedJobRecoveryOutcome(
        unclaimed,
        { kind: 'retryable_error', reason: 'job_observation_failed' },
        job.jobId,
        now,
      ),
    );
    log.warn({ err: error, jobId: job.jobId }, 'Managed job recovery observation failed');
    return null;
  }
}
