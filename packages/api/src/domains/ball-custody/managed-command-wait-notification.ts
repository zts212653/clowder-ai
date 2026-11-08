import { createModuleLogger } from '../../infrastructure/logger.js';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import type { ManagedCommandWakeRecoveryDeps } from './managed-command-wake-lifecycle.js';

const log = createModuleLogger('ball-custody/managed-wait-notification');

/** The existing wait owns this outbox. A committed Message, not a process-local flag, acknowledges notification. */
export async function deliverManagedCommandWaitNotification(
  deps: ManagedCommandWakeRecoveryDeps,
  task: DynamicTaskDef,
  now: number,
): Promise<void> {
  const store = deps.dynamicTaskStore;
  const snapshot = store.getManagedCommandRecoveryState?.(task.id);
  const notification = snapshot?.fact.notification;
  if (!snapshot || !notification || notification.deliveredAt !== undefined || notification.attempts >= 5) return;
  const target = notification.target;
  if (!target) {
    store.updateManagedCommandRecoveryState?.(task.id, snapshot.revision, { ...snapshot.fact, nextAttemptAt: null });
    return;
  }
  let delivered = false;
  try {
    if (deps.canNotifyOwner && !(await deps.canNotifyOwner(target))) {
      store.updateManagedCommandRecoveryState?.(task.id, snapshot.revision, { ...snapshot.fact, nextAttemptAt: null });
      return;
    }
    const existing = await deps.messageStore.getByIdempotencyKey(target.userId, target.threadId, notification.key);
    if (!existing)
      await deps.messageStore.append({
        from: { kind: 'system', service: 'hold-ball' },
        userId: target.userId,
        threadId: target.threadId,
        content: `这条等待的自动恢复已暂停（${notification.reasonCode}）。原记录和执行结果仍保留；重新检查只核对这次执行。`,
        mentions: [],
        timestamp: now,
        idempotencyKey: notification.key,
        source: {
          connector: 'hold-ball',
          label: '等待需检查',
          icon: '🏓',
          meta: { taskId: task.id, phase: 'status', recoveryDisposition: true, cancelable: 'unchanged' },
        },
      });
    delivered = true;
  } catch (err) {
    try {
      delivered = !!(await deps.messageStore.getByIdempotencyKey(target.userId, target.threadId, notification.key));
    } catch {
      /* The outcome remains unknown; the durable outbox is retained. */
    }
    if (!delivered) log.warn({ err, taskId: task.id }, 'Managed wait notification remains pending');
  }
  const latest = store.getManagedCommandRecoveryState?.(task.id);
  if (!latest || latest.fact.notification?.key !== notification.key) return;
  const attempts = notification.attempts + (delivered ? 0 : 1);
  const nextAttemptAt =
    delivered || attempts >= 5 ? (latest.fact.disposition ? null : latest.fact.nextAttemptAt) : now + 30_000;
  store.updateManagedCommandRecoveryState?.(task.id, latest.revision, {
    ...latest.fact,
    nextAttemptAt,
    notification: { ...notification, attempts, ...(delivered ? { deliveredAt: now } : {}) },
  });
}
