import { RECALL_DISPLAY_DOC_KINDS, type RecallResolverFamily } from '@cat-cafe/shared';
import type { RecallGroup } from './recall-feed-model';
import type { RecallEvent, RecallResultItem } from './recall-types';

export const RESOLVER_LABELS: Record<RecallResolverFamily, string> = {
  person_entity: '人物',
  operational_precedent: '经验先例',
  taste: '品味',
  profile: '画像',
  event: '事件',
  decision: '决策',
  project_knowledge: '功能',
  cat_owned_seed: '猫自己的种子',
  thread_overview: '线程概况',
};
const TYPE_LABELS: Record<string, string> = {
  ...RESOLVER_LABELS,
  feature: '功能',
  architecture: '架构',
  lesson: '教训',
  feedback: '反馈',
  research: '调研',
  discussion: '讨论',
  phase: '阶段',
  plan: '计划',
  spec: '规格',
  adr: '决策',
  knowledge: '知识',
  thread: '对话',
  session: '会话',
  person: '人物',
  entity: '实体',
  commit: '提交',
};
export const recallTypeLabel = (sourceType?: string) => TYPE_LABELS[sourceType ?? ''] ?? '记忆';
const UNAVAILABLE_LABELS = {
  source_corrected: '来源已更正',
  source_forgotten: '来源已遗忘',
  scope_revoked: '来源已不可访问',
};
function hasReadableTitle(item: RecallResultItem): boolean {
  const title = item.title.trim();
  return !!title && title !== item.anchor && !/^(?:thread-thread_|person-memory:|person_[A-Za-z0-9_-]+$)/.test(title);
}
export function recallResultTitle(item: RecallResultItem): string {
  if (item.sourceUnavailableReason && Object.hasOwn(UNAVAILABLE_LABELS, item.sourceUnavailableReason)) {
    return `${recallTypeLabel(item.sourceType)} · ${UNAVAILABLE_LABELS[item.sourceUnavailableReason]}`;
  }
  if (item.titleStatus === 'loading') return `${recallTypeLabel(item.sourceType)} · 正在读取标题…`;
  if (item.titleStatus === 'unavailable') return `${recallTypeLabel(item.sourceType)} · 暂时读不到标题`;
  return hasReadableTitle(item) ? item.title : `${recallTypeLabel(item.sourceType)} · 标题没有记录下来`;
}
export function recallResultHref(item: RecallResultItem): string | null {
  if (item.titleStatus) return null;
  if (item.href !== undefined) return item.href;
  if (!hasReadableTitle(item) || !item.anchor) return null;
  // Live results from these existing readers have navigable anchors. Other lanes need their own detail reader.
  if (item.sourceType === 'thread' && item.anchor.startsWith('thread-'))
    return `/thread/${encodeURIComponent(item.anchor.slice(7))}`;
  if (RECALL_DISPLAY_DOC_KINDS.some((kind) => kind === item.sourceType))
    return `/memory/search?q=${encodeURIComponent(item.anchor)}`;
  return null;
}
export function recallDeliveryLabel(event: RecallEvent): string | undefined {
  return event.cueStatus ? `点名递送 · ${recallTypeLabel(event.resolverFamily)}` : undefined;
}
export function recallReplyTimeLabel(group: RecallGroup, earlierRepliesPending: boolean, now = new Date()): string {
  if (group.timestamp == null) {
    return earlierRepliesPending && group.catId && group.invocationId ? '较早的回复' : '没有记录是哪一次回复';
  }
  const date = new Date(group.timestamp);
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const prefix =
    day === today
      ? ''
      : day === yesterday
        ? '昨天 '
        : `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 `;
  return `${prefix}${time} 的回复`;
}
