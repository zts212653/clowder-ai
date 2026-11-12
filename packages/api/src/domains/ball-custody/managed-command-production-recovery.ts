import { createModuleLogger } from '../../infrastructure/logger.js';
import { readManagedJobRecovery, updateManagedJobRecovery } from '../managed-job/managed-job-recovery-ledger.js';
import { applyManagedJobRecoveryOutcome } from '../managed-job/managed-job-recovery-state.js';
import type { DurableManagedGateJob } from '../managed-job/managed-job-types.js';
import { acknowledgeManagedCommandProductionHandoff } from './managed-command-production-handoff.js';
import type { ManagedCommandWakeRecoveryDeps } from './managed-command-wake-lifecycle.js';

const log = createModuleLogger('ball-custody/managed-production-recovery');

/** The job retains production responsibility until exact receipt evidence or an explicit recovery disposition. */
export async function recoverManagedCommandProduction(
  deps: ManagedCommandWakeRecoveryDeps,
  job: DurableManagedGateJob,
  now: number,
): Promise<void> {
  try {
    let snapshot = readManagedJobRecovery(job);
    if (!snapshot) return;
    if (snapshot.recovery.disposition) {
      const { notification: _legacyNotification, ...recovery } = snapshot.recovery as typeof snapshot.recovery & {
        notification?: unknown;
      };
      updateManagedJobRecovery(job, snapshot.revision, { ...recovery, nextAttemptAt: null });
      return;
    }
    if (snapshot.recovery.wakeIntent?.status !== 'pending') return;
    const task = deps.dynamicTaskStore.getById(job.originTaskId);
    if (!task) throw new Error('production_wait_unavailable');
    await acknowledgeManagedCommandProductionHandoff(deps, task.id, now);
    snapshot = readManagedJobRecovery(job);
    if (!snapshot || snapshot.recovery.wakeIntent?.status !== 'pending') return;
    const receiver = deps.dynamicTaskStore.getManagedCommandRecoveryState?.(task.id);
    if (!receiver?.fact.disposition || receiver.fact.reasonCode === 'producer_parked') return;
    // The receiver already owns the incident notice. Retain an exact reference without creating a second notice.
    updateManagedJobRecovery(job, snapshot.revision, {
      ...snapshot.recovery,
      disposition: 'parked',
      reasonCode: 'receiver_parked',
      nextAttemptAt: null,
      wakeIntent: {
        ...snapshot.recovery.wakeIntent,
        ownerWaitRef: `command:${task.id}:g${receiver.fact.waitGeneration ?? 0}`,
      },
    });
  } catch (err) {
    const current = readManagedJobRecovery(job);
    if (!current || current.recovery.disposition) return;
    const recovery = applyManagedJobRecoveryOutcome(
      current.recovery,
      { kind: 'retryable_error', reason: 'production_receipt_observation_failed' },
      job.jobId,
      now,
    );
    if (updateManagedJobRecovery(job, current.revision, recovery)) {
      log.warn({ err, jobId: job.jobId }, 'Managed job production receipt observation failed');
    }
  }
}
