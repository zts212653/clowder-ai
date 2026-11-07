import type { MessageSearchInput, MessageSearchResponse } from '@cat-cafe/shared';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { IEvidenceStore } from '../memory/interfaces.js';
import { MessageSearchService } from '../memory/MessageSearchService.js';
import { boundMessageSearchResponse } from '../memory/message-search-budget.js';
import type { ConciergeSearchContextResult, HandleEntry } from './concierge-search-context.js';

export type ConciergeMessageSearch = (input: MessageSearchInput) => Promise<MessageSearchResponse>;

export function createConciergeMessageSearch(deps: {
  evidenceStore?: IEvidenceStore;
  threadStore?: IThreadStore | null;
  messageStore: IMessageStore;
  userId: string;
  source?: { threadId: string; messageId: string };
}): ConciergeMessageSearch {
  const { evidenceStore, threadStore, messageStore } = deps;
  if (!evidenceStore || !threadStore)
    return async () => {
      throw new Error('Message search unavailable');
    };
  const service = new MessageSearchService({ evidenceStore, threadStore, messageStore });
  return (input) =>
    service.search(input, { userId: deps.userId, viewer: { type: 'user' }, publicReply: true, source: deps.source });
}

export async function buildConciergeMessageSearchContext(
  query: string,
  search: ConciergeMessageSearch,
  maxResults: number,
  binding: (label: string, anchor: HandleEntry['anchor']) => string,
): Promise<ConciergeSearchContextResult> {
  let response: MessageSearchResponse;
  try {
    response = await search({ query, sort: 'time', mode: 'hybrid', limit: maxResults });
  } catch {
    return { handles: [], handleCount: 0, contextString: '\n消息检索暂不可用；不能据此断言没有相关消息。\n' };
  }
  const results = response.results.filter((result) => result.publiclyQuotable).slice(0, maxResults);
  const handles: HandleEntry[] = results.map((result, index) => ({
    label: `R${index + 1}`,
    // Existing navigation protocol: a thread anchor optionally pinpoints one message.
    anchor: { type: 'thread', threadId: result.threadId, messageId: result.messageId, title: result.threadTitle },
  }));
  const lines = ['', '**消息检索候选（复制对应完整标记；只表示本次可核来源）：**'];
  if (response.meta.resultKind === 'sources') lines.push('以下是供你阅读判断的原文，不是系统已判断支持答案的材料。');
  for (let index = 0; index < handles.length; index++) {
    const handle = handles[index];
    const result = results[index];
    lines.push(
      `- ${handle.label}: ${result.speaker === 'connector' ? (result.speakerLabel ?? 'connector') : result.speaker} · ${new Date(result.timestamp).toISOString()} · 《${handle.anchor.title}》 — [跳过去 ${binding(handle.label, handle.anchor)}] — ${result.snippet.text.slice(0, 160)}`,
    );
    if (result.matchEvidence) {
      const { kind, terms } = result.matchEvidence;
      lines.push(
        terms.length
          ? `  命中词：${terms.slice(0, 8).join('、')}${terms.length > 8 ? '（其余见结构化结果）' : ''}。`
          : kind === 'semantic'
            ? '  语义召回，未发现问句字面词，不补造高亮。'
            : '  词法召回，原文字形与问句可能不同。',
      );
    }
  }
  lines.push(`范围：${response.meta.scope === 'thread' ? '当前对话' : '全局可读对话'}；排序：按时间。`);
  const qualification = response.meta.qualification;
  if (qualification?.status === 'partial')
    lines.push(`${qualification.unassessed + qualification.indeterminate} 条候选尚未核对出结论，不能将其当作不相关。`);
  if (response.meta.degraded) lines.push('本次检索已降级到词法；语义命中可能不完整。');
  const window = response.meta.timeWindow;
  if (window)
    lines.push(
      window.complete
        ? `按相关度取得前 ${window.limit} 条来源后按时间排，窗口外仍可能有更早原文。`
        : `本次只核完 ${window.admitted} 条来源，未读满 ${window.limit} 条窗口；时间序仅覆盖这些来源。`,
    );
  lines.push('这是有限索引候选，不代表完整历史或第一次；最近消息可能尚未入索引，延迟暂无法确认。', '');
  const hidden = response.results.some((result) => !result.publiclyQuotable);
  return {
    handles,
    handleCount: handles.length,
    contextString: lines.join('\n'),
    messageSearch: boundMessageSearchResponse({
      ...response,
      results,
      meta: { ...response.meta, hasMore: hidden ? false : response.meta.hasMore },
    }),
  };
}
