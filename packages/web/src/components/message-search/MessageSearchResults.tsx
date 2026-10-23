'use client';

import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { Fragment } from 'react';
import { MessageResultSpeaker } from './MessageResultSpeaker';

export interface MessageSearchResultsProps {
  response?: MessageSearchResponse;
  status: 'idle' | 'loading' | 'ready' | 'error' | 'forbidden';
  currentThreadId: string;
  onNavigate: (result: MessageSearchResult, response: MessageSearchResponse) => void;
  onSortChange?: (sort: 'time' | 'relevance') => void;
  onRetry?: () => void;
  readonly?: boolean;
  resolveSpeaker?: (speaker: string) => string;
}

const buttonClass =
  'rounded-lg border border-[var(--console-border-soft)] px-3 py-1 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]';

function HighlightedSnippet({ result }: { result: MessageSearchResult }) {
  const text = result.snippet.text;
  const ranges = result.highlights
    .filter(
      (range) =>
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.start >= 0 &&
        range.end > range.start &&
        range.end <= result.snippet.text.length,
    )
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  const pieces = ranges.map((range) => {
    if (range.start < cursor || range.start >= text.length) return null;
    const start = cursor;
    cursor = Math.min(range.end, text.length);
    return (
      <Fragment key={`${range.start}:${range.end}`}>
        {text.slice(start, range.start)}
        <mark className="rounded bg-[var(--accent-100)] text-cafe-black">{text.slice(range.start, cursor)}</mark>
      </Fragment>
    );
  });
  return (
    <>
      {pieces}
      {text.slice(cursor)}
    </>
  );
}

function Coverage({ response }: { response: MessageSearchResponse }) {
  const { meta } = response;
  return (
    <div
      className="space-y-1 border-t border-[var(--console-border-soft)] px-3 py-2 text-xs text-cafe-muted"
      role="note"
    >
      <p>
        {meta.scope === 'thread' ? '检索范围：当前对话。' : '检索范围：全局（你可访问的对话）。'} 索引覆盖范围尚未确认。
      </p>
      <p>最近消息可能尚未入索引，延迟暂无法确认。</p>
      {meta.qualification?.status === 'partial' && (
        <p>{meta.qualification.unassessed + meta.qualification.indeterminate} 条候选尚未核对出结论，未作为匹配。</p>
      )}
      {(meta.hasMore || meta.partial || meta.response.truncated || meta.semanticCandidatesLimited) && (
        <p>仅列出部分命中，不能据此判断没有其他消息。</p>
      )}
      {meta.degraded && (
        <p>{meta.effectiveMode === 'lexical' ? '当前使用关键词检索，按意思检索暂不可用。' : '检索仅部分可用。'}</p>
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
          <ol className="divide-y divide-[var(--console-border-soft)] px-3">
            {response.results.map((result, index) => (
              <li
                key={`${result.threadId}:${result.messageId}`}
                data-message-search-result
                className="flex items-center gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-cafe-muted">
                    <MessageResultSpeaker speaker={result.speaker} label={speakerLabel(result)} />
                    <time dateTime={new Date(result.timestamp).toISOString()}>
                      {new Intl.DateTimeFormat(undefined, {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      }).format(result.timestamp)}
                    </time>
                    {response.meta.scope === 'global' && (
                      <span>
                        {result.threadId === currentThreadId ? '当前对话' : result.threadTitle || '对话标题不可用'}
                      </span>
                    )}
                    {index === 0 && response.meta.sort === 'time' && <span>本次结果中最早</span>}
                  </div>
                  <p className="break-words text-sm leading-6 text-cafe-secondary">
                    <HighlightedSnippet result={result} />
                  </p>
                </div>
                {!readonly && (
                  <button
                    type="button"
                    className={`${buttonClass} shrink-0`}
                    onClick={() => onNavigate(result, response)}
                    aria-label={`跳过去：${speakerLabel(result)} · 第${index + 1}处`}
                  >
                    跳过去 ›
                  </button>
                )}
              </li>
            ))}
          </ol>
          <Coverage response={response} />
        </>
      )}
    </section>
  );
}
