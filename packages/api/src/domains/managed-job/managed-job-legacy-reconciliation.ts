import { createModuleLogger } from '../../infrastructure/logger.js';
import { closeSupervisorStore } from './managed-job-database.js';
import { importLegacyManagedJobHistory } from './managed-job-legacy-import.js';
import { readLegacyManagedJobById } from './managed-job-legacy-read.js';
import {
  discoverLegacyManagedJobReferences,
  type LegacyManagedJobReference,
  openLegacyReferenceStore,
  registerLegacyManagedJobReference,
  selectLegacyManagedJobRecoveryDue,
  updateLegacyManagedJobReference,
} from './managed-job-legacy-reference-store.js';
import { reconcileManagedJobDescriptor } from './managed-job-reconcile-descriptor.js';
import type { ManagedJobObservation } from './managed-job-reconciliation.js';
import { applyManagedJobRecoveryOutcome } from './managed-job-recovery-state.js';
import type { DurableManagedGateJob } from './managed-job-types.js';

const log = createModuleLogger('managed-job/legacy-recovery');

async function reconcileReference(
  dataRoot: string,
  ref: LegacyManagedJobReference,
  now: number,
  epoch: string,
): Promise<ManagedJobObservation | null> {
  if (ref.recovery.disposition) return null;
  try {
    let read = readLegacyManagedJobById(dataRoot, ref.jobId);
    if (read.kind === 'unknown' || (read.record.state !== 'terminal' && !read.job)) {
      const reason = read.kind === 'unknown' ? read.reason : 'legacy_descriptor_unavailable';
      const recovery = applyManagedJobRecoveryOutcome(
        ref.recovery,
        ref.disposition === 'reserved' ? { kind: 'retryable_error', reason } : { kind: 'permanent_error', reason },
        ref.jobId,
        now,
      );
      // Unattributed evidence remains queryable; absence of an owner is not permission to route elsewhere.
      updateLegacyManagedJobReference(dataRoot, ref, {
        ...ref,
        disposition: ref.disposition === 'reserved' && !recovery.disposition ? 'reserved' : 'unknown',
        recovery: ref.job ? recovery : { ...recovery, nextAttemptAt: null },
      });
      return null;
    }
    if (ref.disposition === 'legacy_migrated') {
      const observation = read.job ? await reconcileManagedJobDescriptor(read.job, now, epoch) : null;
      updateLegacyManagedJobReference(dataRoot, ref, {
        ...ref,
        recovery: applyManagedJobRecoveryOutcome(ref.recovery, { kind: 'waiting' }, ref.jobId, now),
      });
      return observation;
    }
    if (read.record.state === 'terminal') {
      importLegacyManagedJobHistory(dataRoot, ref, read, now);
      return read.job ? reconcileManagedJobDescriptor(read.job, now, epoch) : null;
    }
    const job = read.job;
    if (!job) return null;
    const observation = await reconcileManagedJobDescriptor(job, now, epoch);
    read = readLegacyManagedJobById(dataRoot, ref.jobId);
    if (read.kind === 'record' && read.record.state === 'terminal') {
      importLegacyManagedJobHistory(dataRoot, { ...ref, wasLive: true }, read, now);
    } else {
      updateLegacyManagedJobReference(dataRoot, ref, {
        ...ref,
        job,
        wasLive: true,
        disposition: 'live',
        recovery: applyManagedJobRecoveryOutcome(ref.recovery, { kind: 'waiting' }, ref.jobId, now),
      });
    }
    return observation;
  } catch (err) {
    const recovery = applyManagedJobRecoveryOutcome(
      ref.recovery,
      { kind: 'retryable_error', reason: 'legacy_observation_failed' },
      ref.jobId,
      now,
    );
    if (updateLegacyManagedJobReference(dataRoot, ref, { ...ref, recovery }))
      log.warn({ err, jobId: ref.jobId }, 'Legacy managed job recovery failed');
    return null;
  }
}

/** One snapshot discovers source identities; every later batch reads only persisted due refs, never the directory. */
export function prepareLegacyManagedJobRecovery(
  dataRoot: string,
  provided: readonly DurableManagedGateJob[],
  now: number,
): LegacyManagedJobReference[] {
  discoverLegacyManagedJobReferences(dataRoot, now);
  for (const job of provided) registerLegacyManagedJobReference(job, now);
  const db = openLegacyReferenceStore(dataRoot);
  try {
    return selectLegacyManagedJobRecoveryDue(db, now, 100);
  } finally {
    closeSupervisorStore(db);
  }
}

export async function reconcileLegacyManagedJobReference(
  dataRoot: string,
  ref: LegacyManagedJobReference,
  now: number,
  epoch: string,
): Promise<ManagedJobObservation | null> {
  if (ref.recovery.disposition) return null;
  const { claim, ...recovery } = ref.recovery;
  if (claim) {
    updateLegacyManagedJobReference(dataRoot, ref, {
      ...ref,
      recovery: applyManagedJobRecoveryOutcome(
        recovery,
        { kind: 'retryable_error', reason: 'legacy_observation_interrupted' },
        ref.jobId,
        now,
      ),
    });
    return null;
  }
  if (
    !updateLegacyManagedJobReference(dataRoot, ref, {
      ...ref,
      recovery: { ...recovery, claim: { expiresAt: now + 10_000 }, nextAttemptAt: now + 10_000 },
    })
  )
    return null;
  return reconcileReference(dataRoot, { ...ref, revision: ref.revision + 1, recovery }, now, epoch);
}
