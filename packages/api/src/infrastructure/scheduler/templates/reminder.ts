import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import type { ScheduleRunTiming, TaskSpec_P1 } from '../types.js';
import type { DynamicTaskParams, TaskTemplate } from './types.js';

function formatLateness(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1 && minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours >= 1 && remainder > 0) return `${hours} 小时 ${remainder} 分钟`;
  if (hours >= 1) return `${hours} 小时`;
  return `${Math.max(0, ms)} 毫秒`;
}

function formatScheduleTiming(schedule: ScheduleRunTiming | undefined): string {
  if (!schedule?.late || !schedule.scheduledAt) return '';
  const merged = schedule.missedSlots > 0 ? `，已合并 ${schedule.missedSlots} 个后续错过 slot` : '';
  return `本次是 ${schedule.scheduledAt} 预定任务的补拍，实际 ${schedule.firedAt} 触发，迟到 ${formatLateness(schedule.latenessMs)}${merged}。\n`;
}

function isManagedCommandWake(params: Record<string, unknown>): boolean {
  const lifecycle = params.holdLifecycle;
  return (
    typeof lifecycle === 'object' &&
    lifecycle !== null &&
    !Array.isArray(lifecycle) &&
    (lifecycle as Record<string, unknown>).mode === 'wake_when'
  );
}

function isManagedHoldWake(instanceId: string, params: Record<string, unknown>): boolean {
  const lifecycle = params.holdLifecycle;
  return Boolean(
    instanceId.startsWith('hold-ball-') &&
      typeof lifecycle === 'object' &&
      lifecycle !== null &&
      !Array.isArray(lifecycle) &&
      ((lifecycle as Record<string, unknown>).mode === 'timer' ||
        (lifecycle as Record<string, unknown>).mode === 'wake_when'),
  );
}

/** Reminder template — fires on schedule, wakes a cat to handle the reminder in-thread */
export const reminderTemplate: TaskTemplate = {
  templateId: 'reminder',
  label: '定时提醒',
  category: 'system',
  description: '按设定时间唤醒猫猫处理提醒（猫猫会根据内容自主行动）',
  subjectKind: 'none',
  defaultTrigger: { type: 'cron', expression: '0 9 * * *' },
  paramSchema: {
    message: { type: 'string', required: true, description: '提醒内容' },
    targetCatId: { type: 'string', required: false, description: '唤醒哪只猫处理（默认当前注册的猫）' },
  },
  createSpec(instanceId: string, p: DynamicTaskParams): TaskSpec_P1 {
    const message = (p.params.message as string) || '定时提醒';
    const targetCatId = (p.params.targetCatId as string) || null;
    const triggerUserId = (p.params.triggerUserId as string) || 'default-user';
    const ownerAuthProvenance = instanceId.startsWith('hold-ball-') ? p.ownerAuthProvenance : undefined;
    const threadId = p.deliveryThreadId;
    const managedCommandWake = instanceId.startsWith('hold-ball-') && isManagedCommandWake(p.params);
    const managedHoldWake = isManagedHoldWake(instanceId, p.params);
    // F167 Phase M (codex P1): pre-fire defer activation is hold_ball-specific.
    // Gate on the `hold-ball-` instanceId prefix — callback-hold-ball-routes mints those
    // ids, while public /api/schedule/tasks only mints `dyn-*` (schedule.ts:417), so a
    // forged deferWhileThreadBusy on a dyn-* reminder cannot activate pre-fire defer.
    // Defer tuning (interval/maxDefers) is NOT read from public params — it uses
    // TaskRunnerV2 internal defaults — so a deferIntervalMs:0 + huge maxDefers churn
    // attack via /api/schedule/tasks is structurally impossible.
    const deferWhileThreadBusy = p.params.deferWhileThreadBusy === true && instanceId.startsWith('hold-ball-');
    return {
      id: instanceId,
      profile: 'awareness',
      trigger: p.trigger,
      ...(deferWhileThreadBusy && threadId ? { firePolicy: { deferWhileThreadBusy: true, threadId } } : {}),
      admission: {
        async gate() {
          if (!threadId) return { run: false, reason: 'no deliveryThreadId' };
          return { run: true, workItems: [{ signal: message, subjectKey: `thread-${threadId}` }] };
        },
      },
      run: {
        overlap: 'skip',
        timeoutMs: 30_000,
        async execute(_signal, subjectKey, ctx) {
          if (managedCommandWake) {
            if (!ctx.managedCommandWakeRecovery) throw new Error('managed-command wake recovery is unavailable');
            await ctx.managedCommandWakeRecovery(instanceId);
            return;
          }
          if (!ctx.deliver) throw new Error('deliver not available');
          const tid = subjectKey.startsWith('thread-') ? subjectKey.slice(7) : subjectKey;
          const catId = targetCatId ?? ctx.assignedCatId ?? 'opus';
          const content = `${SCHEDULER_TRIGGER_PREFIX} ${formatScheduleTiming(ctx.schedule)}${message}`;

          // RFC §5.2: a scheduled wake is one `conversation_input` envelope. Naming the member makes
          // delivery a single atomic Message + Queue admission, so there is no unadmitted source to
          // compensate for and no second trigger that could be refused.
          const holdSource = {
            connector: 'hold-ball',
            label: '持球唤醒',
            icon: '🏓',
            meta: { managedHold: true, phase: 'wake', cancelable: false, taskId: instanceId, threadId: tid, catId },
          } as const;
          try {
            await ctx.deliver({
              threadId: tid,
              content,
              // F117 ADR-043 D.4: stored userId is the verified trigger owner (tenant), not the
              // author — scheduler authorship is expressed via from: system:scheduler.
              userId: triggerUserId,
              targetCatId: catId,
              sourceCategory: 'scheduled',
              idempotencyKey: managedHoldWake ? `hold-ball-wake:${instanceId}` : `scheduler-wake:${instanceId}`,
              ...(managedHoldWake ? { priority: 'urgent' as const, source: holdSource } : {}),
              ...(ownerAuthProvenance ? { ownerAuthProvenance } : {}),
              ...(managedHoldWake ? {} : { extra: { scheduler: { hiddenTrigger: true } } }),
            });
          } catch (err) {
            if (!managedHoldWake) throw err;
            // A managed hold still owes the user a visible end-of-wait fact when its wake cannot be
            // admitted. Nothing partial exists to roll back — the admission either happened or not.
            const detail = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
            await ctx.deliver({
              threadId: tid,
              userId: triggerUserId,
              content: `等待已结束：唤醒入队失败（${detail}）`,
              idempotencyKey: `hold-ball-wake-failed:${instanceId}`,
              source: {
                connector: 'hold-ball',
                label: '持球状态',
                icon: '🏓',
                meta: {
                  managedHold: true,
                  phase: 'status',
                  cancelable: false,
                  taskId: instanceId,
                  threadId: tid,
                  catId,
                },
              },
            });
          }
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: {
        label: message.slice(0, 30),
        category: 'system',
        description: message,
        subjectKind: 'none',
      },
    };
  },
};
