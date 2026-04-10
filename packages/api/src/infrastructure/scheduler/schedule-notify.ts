/**
 * #415 Phase 2: Task lifecycle notifications
 *
 * Fire-and-forget notifications to delivery threads for lifecycle events:
 * registered, paused, resumed, deleted, failed, missed-window.
 */

import { getNextCronMs } from './cron-utils.js';
import type { DynamicTaskDef } from './DynamicTaskStore.js';
import type { DeliverOpts, TriggerSpec } from './types.js';

type DeliverFn = (opts: DeliverOpts) => Promise<string>;

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

function fire(deliver: DeliverFn | undefined, def: DynamicTaskDef, content: string): void {
  if (!deliver || !def.deliveryThreadId) return;
  deliver({ threadId: def.deliveryThreadId, content, catId: 'system', userId: resolveUserId(def) }).catch(() => {});
}

export function notifyTaskRegistered(deliver: DeliverFn | undefined, def: DynamicTaskDef): void {
  const nextFire = computeNextFireTime(def.trigger);
  const timeStr = nextFire ? formatTime(nextFire) : '未知';
  const once = def.trigger.type === 'once' ? '（一次性，执行后自动退役）' : '';
  fire(deliver, def, `✅ 定时任务「${label(def)}」已创建，下次执行时间：${timeStr}${once}`);
}

export function notifyTaskPaused(deliver: DeliverFn | undefined, def: DynamicTaskDef): void {
  fire(deliver, def, `⏸️ 定时任务「${label(def)}」已暂停`);
}

export function notifyTaskResumed(deliver: DeliverFn | undefined, def: DynamicTaskDef): void {
  const nextFire = computeNextFireTime(def.trigger);
  const timeStr = nextFire ? formatTime(nextFire) : '未知';
  fire(deliver, def, `▶️ 定时任务「${label(def)}」已恢复，下次执行时间：${timeStr}`);
}

export function notifyTaskDeleted(deliver: DeliverFn | undefined, def: DynamicTaskDef): void {
  fire(deliver, def, `🗑️ 定时任务「${label(def)}」已删除`);
}

export function notifyTaskSucceeded(deliver: DeliverFn | undefined, def: DynamicTaskDef): void {
  if (def.trigger.type === 'once') {
    fire(deliver, def, `✅ 定时任务「${label(def)}」已执行完成，任务已自动结束`);
  } else {
    const nextFire = computeNextFireTime(def.trigger);
    const timeStr = nextFire ? formatTime(nextFire) : '未知';
    fire(deliver, def, `✅ 定时任务「${label(def)}」本次执行完成，下次执行时间：${timeStr}`);
  }
}

export function notifyTaskFailed(
  deliver: DeliverFn | undefined,
  def: DynamicTaskDef,
  errorSummary: string | null,
): void {
  const reason = errorSummary ? `：${errorSummary.slice(0, 200)}` : '';
  fire(deliver, def, `❌ 定时任务「${label(def)}」执行失败${reason}`);
}
