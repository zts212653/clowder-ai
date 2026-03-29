import type { TaskSpec_P1 } from '../types.js';
import type { DynamicTaskParams, TaskTemplate } from './types.js';

/** Web digest template — periodically fetch a URL and summarize new content */
export const webDigestTemplate: TaskTemplate = {
  templateId: 'web-digest',
  label: '网页摘要',
  category: 'external',
  description: '定期抓取网页内容并生成摘要',
  subjectKind: 'external',
  defaultTrigger: { type: 'cron', expression: '0 9 * * *' },
  paramSchema: {
    url: { type: 'string', required: true, description: '目标网页 URL' },
    topic: { type: 'string', required: false, description: '关注的主题关键词' },
    targetCatId: { type: 'string', required: false, description: '唤醒哪只猫处理浏览器抓取（默认当前注册的猫）' },
  },
  createSpec(instanceId: string, p: DynamicTaskParams): TaskSpec_P1 {
    const url = (p.params.url as string) || '';
    const topic = (p.params.topic as string) || '';
    const targetCatId = (p.params.targetCatId as string) || null;
    const triggerUserId = (p.params.triggerUserId as string) || 'default-user';
    const threadId = p.deliveryThreadId;
    return {
      id: instanceId,
      profile: 'awareness',
      trigger: p.trigger,
      admission: {
        async gate() {
          if (!url) return { run: false, reason: 'no url param' };
          if (!threadId) return { run: false, reason: 'no deliveryThreadId' };
          return { run: true, workItems: [{ signal: null, subjectKey: `thread-${threadId}` }] };
        },
      },
      run: {
        overlap: 'skip',
        timeoutMs: 60_000,
        async execute(_signal, subjectKey, ctx) {
          if (!ctx.fetchContent) throw new Error('fetchContent not available');
          if (!ctx.deliver) throw new Error('deliver not available');
          const tid = subjectKey.startsWith('thread-') ? subjectKey.slice(7) : subjectKey;
          const result = await ctx.fetchContent(url);
          if (result.method === 'browser') {
            if (!ctx.invokeTrigger) {
              throw new Error('invokeTrigger not available for browser-required digest');
            }
            const catId = targetCatId ?? ctx.assignedCatId ?? 'opus';
            const topicLine = topic ? `\n重点关注：${topic}` : '';
            const triggerContent =
              `[定时任务] 请使用 browser-automation 抓取并汇总网页内容\n` +
              `URL: ${url}${topicLine}\n` +
              `要求：使用真实浏览器处理 JS 重站点，输出今天/当前值得关注的摘要，附标题、简述、来源链接与明确日期。`;
            const messageId = await ctx.deliver({
              threadId: tid,
              content: triggerContent,
              catId: 'system',
              userId: 'scheduler',
            });
            ctx.invokeTrigger.trigger(tid, catId, triggerUserId, triggerContent, messageId, undefined, {
              reason: 'scheduled_web_digest_browser_fetch',
              suggestedSkill: 'browser-automation',
            });
            return;
          }
          const header = result.title || url;
          const topicLine = topic ? `\n**Topic:** ${topic}` : '';
          const truncNote = result.truncated ? '\n_[content truncated]_' : '';
          const content = `## ${header}${topicLine}\n\n${result.text}${truncNote}`;
          await ctx.deliver({
            threadId: tid,
            content,
            catId: ctx.assignedCatId ?? 'system',
            userId: 'scheduler',
          });
        },
      },
      state: { runLedger: 'sqlite' },
      outcome: { whenNoSignal: 'drop' },
      enabled: () => true,
      display: {
        label: topic ? `${topic} 摘要` : '网页摘要',
        category: 'external',
        description: `定期摘要: ${url}`,
        subjectKind: 'external',
      },
    };
  },
};
