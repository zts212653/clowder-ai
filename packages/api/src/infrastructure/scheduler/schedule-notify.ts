/**
 * #415 Phase 2: Task lifecycle notifications
 *
 * Fire-and-forget notifications to delivery threads for lifecycle events:
 * registered, paused, resumed, deleted, failed, missed-window.
 */

import { getNextCronMs } from './cron-utils.js';
import type { DynamicTaskDef } from './DynamicTaskStore.js';
import type {
  ScheduleLifecycleNotifier,
  SchedulerLifecycleEvent,
  SchedulerToastPayload,
  TriggerSpec,
} from './types.js';

export const SCHEDULER_TOAST_DURATION_MS = {
  info: 3200,
  success: 3200,
  error: 6000,
} as const;

/** Compute epoch ms of next fire time for a trigger */
export function computeNextFireTime(trigger: TriggerSpec): number | null {
  if (trigger.type === 'once') return trigger.fireAt;
  if (trigger.type === 'cron') return Date.now() + getNextCronMs(trigger.expression, trigger.timezone);
  if (trigger.type === 'interval') return Date.now() + trigger.ms;
  return null;
}

function formatTime(epoch: number): string {
  return new Date(epoch).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function resolveUserId(def: DynamicTaskDef): string {
  return ((def.params as Record<string, unknown>).triggerUserId as string) ?? 'system';
}

function label(def: DynamicTaskDef): string {
  return def.display?.label ?? def.templateId;
}

function fire(
  notify: ScheduleLifecycleNotifier | undefined,
  def: DynamicTaskDef,
  event: SchedulerLifecycleEvent,
  toast: Omit<SchedulerToastPayload, 'lifecycleEvent'>,
): void {
  if (!notify || !def.deliveryThreadId) return;
  notify({
    threadId: def.deliveryThreadId,
    userId: resolveUserId(def),
    toast: { ...toast, lifecycleEvent: event },
  });
}

export function notifyTaskRegistered(notify: ScheduleLifecycleNotifier | undefined, def: DynamicTaskDef): void {
  const nextFire = computeNextFireTime(def.trigger);
  const timeStr = nextFire ? formatTime(nextFire) : '未知';
  const once = def.trigger.type === 'once' ? '（一次性，执行后自动退役）' : '';
  fire(notify, def, 'registered', {
    type: 'info',
    title: '定时任务已创建',
    message: `「${label(def)}」下次执行时间：${timeStr}${once}`,
    duration: SCHEDULER_TOAST_DURATION_MS.info,
  });
}

export function notifyTaskPaused(notify: ScheduleLifecycleNotifier | undefined, def: DynamicTaskDef): void {
  fire(notify, def, 'paused', {
    type: 'info',
    title: '定时任务已暂停',
    message: `「${label(def)}」已暂停`,
    duration: SCHEDULER_TOAST_DURATION_MS.info,
  });
}

export function notifyTaskResumed(notify: ScheduleLifecycleNotifier | undefined, def: DynamicTaskDef): void {
  const nextFire = computeNextFireTime(def.trigger);
  const timeStr = nextFire ? formatTime(nextFire) : '未知';
  fire(notify, def, 'resumed', {
    type: 'info',
    title: '定时任务已恢复',
    message: `「${label(def)}」下次执行时间：${timeStr}`,
    duration: SCHEDULER_TOAST_DURATION_MS.info,
  });
}

export function notifyTaskDeleted(notify: ScheduleLifecycleNotifier | undefined, def: DynamicTaskDef): void {
  fire(notify, def, 'deleted', {
    type: 'info',
    title: '定时任务已删除',
    message: `「${label(def)}」已删除`,
    duration: SCHEDULER_TOAST_DURATION_MS.info,
  });
}

export function notifyTaskSucceeded(notify: ScheduleLifecycleNotifier | undefined, def: DynamicTaskDef): void {
  // Reminder runs already create a hidden trigger + accented cat reply. Adding a success toast
  // would reintroduce the management-state noise that this hierarchy is meant to remove.
  if (def.templateId === 'reminder') return;
  if (def.trigger.type === 'once') {
    fire(notify, def, 'succeeded', {
      type: 'success',
      title: '定时任务已完成',
      message: `「${label(def)}」已执行完成，任务已自动结束`,
      duration: SCHEDULER_TOAST_DURATION_MS.success,
    });
    return;
  }
  const nextFire = computeNextFireTime(def.trigger);
  const timeStr = nextFire ? formatTime(nextFire) : '未知';
  fire(notify, def, 'succeeded', {
    type: 'success',
    title: '定时任务执行完成',
    message: `「${label(def)}」下次执行时间：${timeStr}`,
    duration: SCHEDULER_TOAST_DURATION_MS.success,
  });
}

export function notifyTaskFailed(
  notify: ScheduleLifecycleNotifier | undefined,
  def: DynamicTaskDef,
  errorSummary: string | null,
): void {
  fire(notify, def, 'failed', {
    type: 'error',
    title: '定时任务执行失败',
    message: `「${label(def)}」${errorSummary ? `：${errorSummary.slice(0, 200)}` : ''}`,
    duration: SCHEDULER_TOAST_DURATION_MS.error,
  });
}
