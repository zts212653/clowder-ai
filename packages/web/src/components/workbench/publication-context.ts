import { type PublicationReviewContext, publicationReviewContextSchema } from '@cat-cafe/shared';
import { z } from 'zod';

export const publicationContextCatalogueSchema = z.object({
  ownerUserId: z.string().min(1),
  contexts: z.array(publicationReviewContextSchema),
});
export function contentContextSelectionKey(ownerUserId: string, contentRef: string) {
  return `cat-cafe:content-context:${ownerUserId}:${contentRef}`;
}
const states = {
  draft: '讨论中',
  awaiting_human: '待审阅',
  approved: '已接受',
  changes_requested: '已请求修改',
  superseded: '历史',
};
/** F309 parent 135: from a generic entry, a review is continued by name, never entered silently. */
export function continueReviewLabel(context: Pick<PublicationReviewContext, 'targetName' | 'title' | 'state'>) {
  return context.state === 'awaiting_human'
    ? `继续${context.targetName}请你判断的：${context.title}`
    : `继续${context.targetName}的审阅：${context.title}`;
}
export function publicationContextLabel(context: PublicationReviewContext) {
  return `${context.targetName} · ${context.threadTitle} · ${context.taskTitle} · 第 ${context.round} 版${context.taskState === 'closed' ? ' · 已收口' : context.state ? ` · ${states[context.state]}` : ''}`;
}
