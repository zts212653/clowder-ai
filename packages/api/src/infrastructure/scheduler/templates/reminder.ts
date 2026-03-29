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
    return {
      id: instanceId,
      profile: 'awareness',
      trigger: p.trigger,
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
          const content = `[定时任务] ${message}`;

          // Store trigger message first → real messageId for InvocationRecord + retry
          const messageId = await ctx.deliver({ threadId: tid, content, catId: 'system', userId: 'scheduler' });

          // Wake a cat to act on the trigger message
          if (ctx.invokeTrigger) {
            ctx.invokeTrigger.trigger(tid, catId, triggerUserId, content, messageId);
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
