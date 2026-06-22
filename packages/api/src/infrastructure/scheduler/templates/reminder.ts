import { SCHEDULER_TRIGGER_PREFIX } from '@cat-cafe/shared';
import { buildHoldExpiredEvent } from '../../../domains/ball-custody/ball-custody-events.js';
import type { TaskSpec_P1 } from '../types.js';
import type { DynamicTaskParams, TaskTemplate } from './types.js';

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
    const threadId = p.deliveryThreadId;
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
          if (!ctx.deliver) throw new Error('deliver not available');
          const tid = subjectKey.startsWith('thread-') ? subjectKey.slice(7) : subjectKey;
          const catId = targetCatId ?? ctx.assignedCatId ?? 'opus';
          const content = `${SCHEDULER_TRIGGER_PREFIX} ${message}`;

          if (instanceId.startsWith('hold-ball-') && p.trigger.type === 'once' && threadId) {
            ctx.ballCustody
              ?.record(buildHoldExpiredEvent({ threadId: tid, catId, fireAt: p.trigger.fireAt, at: Date.now() }))
              .catch(() => {});
          }

          // Store trigger message first → real messageId for InvocationRecord + retry
          const messageId = await ctx.deliver({
            threadId: tid,
            content,
            userId: 'scheduler',
            ...(ctx.invokeTrigger ? { extra: { scheduler: { hiddenTrigger: true } } } : {}),
          });

          // Wake a cat to act on the trigger message
          if (ctx.invokeTrigger) {
            try {
              void Promise.resolve(
                ctx.invokeTrigger.trigger(tid, catId, triggerUserId, content, messageId, undefined, {
                  sourceCategory: 'scheduled',
                }),
              ).catch(() => {});
            } catch {
              // Best-effort: sync trigger throw should not fail the reminder
            }
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
