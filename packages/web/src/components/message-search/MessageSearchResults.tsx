'use client';

import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { MessageDecisionSummary } from './MessageDecisionSummary';
import { searchButtonClass as buttonClass, MessageSearchResultRow } from './MessageSearchResultRow';

export interface MessageSearchResultsProps {
  response?: MessageSearchResponse;
  status: 'idle' | 'loading' | 'ready' | 'error' | 'forbidden';
  currentThreadId: string;
  onNavigate: (result: MessageSearchResult, response: MessageSearchResponse) => void;
  onSortChange?: (sort: 'time' | 'relevance') => void;
  onRetry?: () => void;
  readonly?: boolean;
  journey6?: boolean;
  resolveSpeaker?: (speaker: string) => string;
}

function Coverage({ response, journey6 }: { response: MessageSearchResponse; journey6: boolean }) {
  const { meta } = response;
  const partial = meta.hasMore || meta.partial || meta.response.truncated || meta.semanticCandidatesLimited;
  return (
    <div
      className="space-y-1 border-t border-[var(--console-border-soft)] px-3 py-2 text-xs text-cafe-muted"
      role="note"
    >
      {journey6 ? (
        <p>
          {partial ? '这里只列出部分结果' : '可能还有没搜到的'}，最近消息和所选范围是否已经找全还不能确认。
          {meta.qualification?.status === 'partial' &&
            `另有${meta.qualification.unassessed + meta.qualification.indeterminate}条候选还没核对完。`}
          {meta.degraded &&
            (meta.effectiveMode === 'lexical' ? '按意思查找暂不可用，现用关键词查找。' : '部分查找暂不可用。')}
        </p>
      ) : (
        <>
          <p>
            {meta.scope === 'thread' ? '检索范围：当前对话。' : '检索范围：全局（你可访问的对话）。'}{' '}
            索引覆盖范围尚未确认。
          </p>
          <p>最近消息可能尚未入索引，延迟暂无法确认。</p>
          {meta.qualification?.status === 'partial' && (
            <p>{meta.qualification.unassessed + meta.qualification.indeterminate} 条候选尚未核对出结论，未作为匹配。</p>
          )}
          {partial && <p>仅列出部分命中，不能据此判断没有其他消息。</p>}
          {meta.degraded && (
            <p>{meta.effectiveMode === 'lexical' ? '当前使用关键词检索，按意思检索暂不可用。' : '检索仅部分可用。'}</p>
          )}
        </>
      )}
    </div>
  );
}

export function MessageSearchResults({
  response,
  status,
  currentThreadId,
  onNavigate,
  onSortChange,
  onRetry,
  readonly = false,
  journey6 = false,
  resolveSpeaker = (speaker) => speaker,
}: MessageSearchResultsProps) {
  const speakerLabel = (result: MessageSearchResult) =>
    result.speaker === 'system'
      ? '系统通知'
      : result.speaker === 'connector'
        ? result.speakerLabel || '外部来源'
        : resolveSpeaker(result.speaker);
  const inactive = status !== 'ready' || !response;
  const stateText =
    status === 'loading'
      ? '正在搜索…'
      : status === 'forbidden'
        ? '无法访问此检索范围。'
        : status === 'error'
          ? '检索暂不可用，不能据此判断没有相关消息。'
          : '输入内容查找以前的消息。';
  return (
    <section
      aria-label="消息检索结果"
      className="overflow-hidden rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)]"
    >
      {inactive ? (
        <div className="space-y-2 p-3 text-sm text-cafe-secondary" role={status === 'error' ? 'alert' : 'status'}>
          <p>{stateText}</p>
          {status === 'error' && onRetry && !readonly && (
            <button type="button" className={buttonClass} onClick={onRetry}>
              重试检索
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 border-b border-[var(--console-border-soft)] px-3 py-2 text-xs text-cafe-muted">
            <div className="flex gap-3" role="group" aria-label="结果排序">
              {(['time', 'relevance'] as const).map((sort) =>
                onSortChange && !readonly ? (
                  <button
                    type="button"
                    key={sort}
                    aria-pressed={response.meta.sort === sort}
                    onClick={() => onSortChange(sort)}
                    className="rounded px-1.5 py-0.5 text-cafe-secondary aria-pressed:bg-[var(--console-hover-bg)] aria-pressed:font-medium aria-pressed:text-cafe-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]"
                  >
                    {sort === 'time' ? '按时间' : '按相关'}
                  </button>
                ) : (
                  response.meta.sort === sort && <span key={sort}>{sort === 'time' ? '按时间' : '按相关'}</span>
                ),
              )}
            </div>
            <span>{response.results.length} 处</span>
          </div>
          {response.results.length === 0 && (
            <p className="p-3 text-sm text-cafe-secondary" role="status">
              {response.meta.qualification?.status === 'partial'
                ? '部分候选尚未核对完，暂不能判断是否有匹配。'
                : '本次检索未找到相关消息。'}
            </p>
          )}
          {journey6 && !readonly && (
            <MessageDecisionSummary response={response} threadId={currentThreadId} resolveSpeaker={resolveSpeaker} />
          )}
          {journey6 && response.meta.decisionIndex?.status === 'unavailable' && (
            <p role="note" className="px-3 py-2 text-xs text-cafe-muted">
              这次未能载入已定事项，先不显示标签。
            </p>
          )}
          <ol className="divide-y divide-[var(--console-border-soft)] px-3">
            {response.results.map((result, index) => (
              <MessageSearchResultRow
                key={`${response.searchId}:${currentThreadId}:${result.threadId}:${result.messageId}:${result.contentRevision}`}
                result={result}
                response={response}
                index={index}
                currentThreadId={currentThreadId}
                speaker={speakerLabel(result)}
                resolveSpeaker={resolveSpeaker}
                journey6={journey6}
                readonly={readonly}
                onNavigate={onNavigate}
              />
            ))}
          </ol>
          <Coverage response={response} journey6={journey6} />
        </>
      )}
    </section>
  );
}
