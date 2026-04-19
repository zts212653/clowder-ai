/**
 * F160 AC-E3: Monthly Review Scheduler Template
 *
 * Generates a Markdown growth review per cat and delivers it to a thread.
 * Default cron: 1st of every month at 09:00.
 * If no targetCatId param, generates for all registered cats.
 */

import { catRegistry } from '@cat-cafe/shared';
import type { MonthlyReviewService } from '../../../domains/cats/services/growth/MonthlyReviewService.js';
import type { TaskSpec_P1 } from '../types.js';
import type { DynamicTaskParams, TaskTemplate } from './types.js';

export function createMonthlyReviewTemplate(reviewService: MonthlyReviewService): TaskTemplate {
  return {
    templateId: 'monthlyReview',
    label: '月度足迹回顾',
    category: 'system',
    description: '每月自动生成猫猫成长回顾报告',
    subjectKind: 'none',
    defaultTrigger: { type: 'cron', expression: '0 9 1 * *' },
    paramSchema: {
      targetCatId: { type: 'string', required: false, description: '指定猫猫（留空生成全部）' },
    },
    createSpec(instanceId: string, p: DynamicTaskParams): TaskSpec_P1 {
      const targetCatId = (p.params.targetCatId as string) || null;
      const threadId = p.deliveryThreadId;
      return {
        id: instanceId,
        profile: 'awareness',
        trigger: p.trigger,
        admission: {
          async gate() {
            if (!threadId) return { run: false, reason: 'no deliveryThreadId' };
            const ids = targetCatId ? [targetCatId] : catRegistry.getAllIds().map(String);
            return { run: true, workItems: ids.map((id) => ({ signal: id, subjectKey: `review-${id}` })) };
          },
        },
        run: {
          overlap: 'skip',
          timeoutMs: 60_000,
          async execute(signal, _subjectKey, ctx) {
            if (!ctx.deliver) throw new Error('deliver not available');
            const catId = signal as string;
            const review = await reviewService.generate(catId);
            if (!review) return;
            await ctx.deliver({ threadId: threadId!, content: review, userId: 'scheduler' });
          },
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
        display: {
          label: '月度足迹回顾',
          category: 'system',
          description: targetCatId ? `${targetCatId} 月度回顾` : '全猫月度回顾',
          subjectKind: 'none',
        },
      };
    },
  };
}
