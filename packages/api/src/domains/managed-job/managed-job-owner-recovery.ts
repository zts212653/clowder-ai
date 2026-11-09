import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { runDueBatch } from '../../infrastructure/recovery/run-due-batch.js';
import { schedulerError } from '../../infrastructure/scheduler/logging/adapter.js';
import { validateDurableManagedGateJob } from './durable-managed-gate-job-validation.js';
import { closeSupervisorStore, withSupervisorStores } from './managed-job-database.js';
import { reconcileManagedJobDueRow } from './managed-job-due-reconciliation.js';
import {
  prepareLegacyManagedJobRecovery,
  reconcileLegacyManagedJobReference,
} from './managed-job-legacy-reconciliation.js';
import {
  openLegacyReferenceStore,
  readLegacyManagedJobReference,
  selectLegacyManagedJobRecoveryDue,
  updateLegacyManagedJobReference,
} from './managed-job-legacy-reference-store.js';
import type { ManagedJobObservation } from './managed-job-reconciliation.js';
import {
  listManagedJobRecoveryDue,
  readManagedJobRecovery,
  updateManagedJobRecovery,
} from './managed-job-recovery-ledger.js';
import { applyManagedJobRecoveryOutcome } from './managed-job-recovery-state.js';
import type { DurableManagedGateJob } from './managed-job-types.js';

const log = createModuleLogger('managed-job/owner-batch');

/** A fixed owner batch shares one deadline across native and legacy work, oldest due first. */
export async function reconcileManagedJobOwnerBatch(
  dataRoot: string,
  locator: DurableManagedGateJob,
  legacyJobs: readonly DurableManagedGateJob[],
  now: number,
  epoch: string,
): Promise<ManagedJobObservation[]> {
  return withSupervisorStores(async () => {
    const native = listManagedJobRecoveryDue(locator, now).map((row) => ({
      jobId: row.jobId,
      due: row.recovery.nextAttemptAt ?? 0,
      run: () => reconcileManagedJobDueRow(row, locator, dataRoot, now, epoch),
      fail: () => {
        const job = { ...locator, jobId: row.jobId };
        const current = readManagedJobRecovery(job);
        if (current && !current.recovery.disposition)
          updateManagedJobRecovery(
            job,
            current.revision,
            applyManagedJobRecoveryOutcome(
              current.recovery,
              { kind: 'retryable_error', reason: 'owner_batch_item_failed' },
              job.jobId,
              now,
            ),
          );
      },
    }));
    const legacy = prepareLegacyManagedJobRecovery(dataRoot, legacyJobs, now).map((ref) => ({
      jobId: ref.jobId,
      due: ref.recovery.nextAttemptAt ?? 0,
      run: () => reconcileLegacyManagedJobReference(dataRoot, ref, now, epoch),
      fail: () => {
        const current = readLegacyManagedJobReference(dataRoot, ref.jobId);
        if (current && !current.recovery.disposition)
          updateLegacyManagedJobReference(dataRoot, current, {
            ...current,
            recovery: applyManagedJobRecoveryOutcome(
              current.recovery,
              { kind: 'retryable_error', reason: 'legacy_batch_item_failed' },
              ref.jobId,
              now,
            ),
          });
      },
    }));
    const due = [...native, ...legacy].sort((a, b) => a.due - b.due || a.jobId.localeCompare(b.jobId));
    const batch = await runDueBatch({
      limit: 200,
      budgetMs: 5000,
      selectDue: () => due,
      process: (selected) => selected.run(),
      onItemError: (selected, error) => {
        try {
          selected.fail();
        } finally {
          log.warn({ jobId: selected.jobId, err: schedulerError(error) }, 'Managed owner batch item failed');
        }
      },
    });
    return batch.results.filter((row): row is ManagedJobObservation => row !== null);
  });
}

/** Production receipts/notices must remain discoverable after the consumer has retired its own due entry. */
export function readManagedJobDueDescriptors(
  dataRoot: string,
  locator: DurableManagedGateJob,
  now: number,
): DurableManagedGateJob[] {
  if (!existsSync(join(dataRoot, 'managed-jobs', 'supervisor.sqlite'))) return [];
  const native = listManagedJobRecoveryDue(locator, now);
  const db = openLegacyReferenceStore(dataRoot);
  try {
    return [
      ...native.flatMap(({ record }) => (record.descriptor ? [record.descriptor as DurableManagedGateJob] : [])),
      ...selectLegacyManagedJobRecoveryDue(db, now, 100).flatMap(({ job }) => (job ? [job] : [])),
    ].filter((job) => validateDurableManagedGateJob(job, job.originTaskId, dataRoot));
  } finally {
    closeSupervisorStore(db);
  }
}
