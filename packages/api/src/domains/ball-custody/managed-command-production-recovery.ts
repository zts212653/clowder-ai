import { createModuleLogger } from '../../infrastructure/logger.js';
import { readManagedJobRecovery, updateManagedJobRecovery } from '../managed-job/managed-job-recovery-ledger.js';
import { applyManagedJobRecoveryOutcome } from '../managed-job/managed-job-recovery-state.js';
import type { DurableManagedGateJob } from '../managed-job/managed-job-types.js';
import { acknowledgeManagedCommandProductionHandoff } from './managed-command-production-handoff.js';
import type { ManagedCommandWakeRecoveryDeps } from './managed-command-wake-lifecycle.js';

const log = createModuleLogger('ball-custody/managed-production-recovery');

async function notifyJobOwner(deps: ManagedCommandWakeRecoveryDeps, job: DurableManagedGateJob, now: number) {
  const snapshot = readManagedJobRecovery(job);
  const notification = snapshot?.recovery.notification;
  if (!snapshot || !notification || notification.deliveredAt !== undefined || notification.attempts >= 5) return;
  const target = job.wakeTarget;
  let delivered = false;
  try {
    if (deps.canNotifyOwner && !(await deps.canNotifyOwner(target))) {
      updateManagedJobRecovery(job, snapshot.revision, { ...snapshot.recovery, nextAttemptAt: null });
      return;
    }
    const existing = await deps.messageStore.getByIdempotencyKey(target.userId, target.threadId, notification.key);
    if (!existing)
      await deps.messageStore.append({
        from: { kind: 'system', service: 'managed-job' },
        userId: target.userId,
        threadId: target.threadId,
        content: `这次命令的自动恢复已暂停（${notification.reasonCode}）。原执行记录和结果仍保留；清理未经证明时，执行责任和资源仍保留。`,
        mentions: [],
        timestamp: now,
        idempotencyKey: notification.key,
        source: {
          connector: 'hold-ball',
          label: '命令需检查',
          icon: '🏓',
          meta: {
            taskId: job.originTaskId,
            jobId: job.jobId,
            phase: 'status',
            recoveryDisposition: true,
            cancelable: 'unchanged',
          },
        },
      });
    delivered = true;
  } catch (err) {
    try {
      delivered = !!(await deps.messageStore.getByIdempotencyKey(target.userId, target.threadId, notification.key));
    } catch {
      /* Retain the owner outbox when the commit cannot be verified. */
    }
    if (!delivered) log.warn({ err, jobId: job.jobId }, 'Managed job disposition notice remains pending');
  }
  const current = readManagedJobRecovery(job);
  if (!current || current.recovery.notification?.key !== notification.key) return;
  const attempts = notification.attempts + (delivered ? 0 : 1);
  updateManagedJobRecovery(job, current.revision, {
    ...current.recovery,
    nextAttemptAt: delivered || attempts >= 5 ? null : now + 30_000,
    notification: { ...notification, attempts, ...(delivered ? { deliveredAt: now } : {}) },
  });
}

/** The job retains production responsibility until exact receipt evidence or an explicit recovery disposition. */
export async function recoverManagedCommandProduction(
  deps: ManagedCommandWakeRecoveryDeps,
  job: DurableManagedGateJob,
  now: number,
): Promise<void> {
  try {
    let snapshot = readManagedJobRecovery(job);
    if (!snapshot) return;
    if (snapshot.recovery.disposition) return await notifyJobOwner(deps, job, now);
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
      if (recovery.notification) await notifyJobOwner(deps, job, now);
    }
  }
}
