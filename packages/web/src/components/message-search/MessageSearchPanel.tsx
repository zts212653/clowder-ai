'use client';

import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppTooltip } from '../AppTooltip';
import { ShellGlyph } from '../shell/ShellIcons';
import { useShellPresentation } from '../shell/shell-presentation';
import { MessageSearchResults } from './MessageSearchResults';
import type { MessageFindDestination, MessageFindState } from './message-find-state';
import { useMessageSearch } from './useMessageSearch';

export function MessageSearchPanel({
  threadId,
  onClose,
  onNavigate,
  resolveSpeaker,
  onOpenDestination,
  initialState,
}: {
  threadId: string;
  onClose: () => void;
  onNavigate: (result: MessageSearchResult, response: MessageSearchResponse) => void;
  resolveSpeaker?: (speaker: string) => string;
  onOpenDestination?: (destination: MessageFindDestination, state: MessageFindState) => void;
  initialState?: MessageFindState;
}) {
  const journey6 = useShellPresentation() === 'v2';
  const [query, setQuery] = useState(initialState?.query ?? '');
  const [scope, setScope] = useState<'thread' | 'global'>(initialState?.scope ?? 'thread');
  const [sort, setSort] = useState<'time' | 'relevance'>(initialState?.sort ?? 'time');
  const input = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const search = useMessageSearch(threadId, initialState);
  useLayoutEffect(() => {
    if (scroll.current && initialState) scroll.current.scrollTop = initialState.scrollTop;
  }, [initialState]);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const selectScope = (next: 'thread' | 'global') => {
    setScope(next);
    if (query.trim()) void search.search(query, next, sort);
  };
  const selectSort = (next: 'time' | 'relevance') => {
    setSort(next);
    if (query.trim()) void search.search(query, scope, next);
  };
  return (
    <div
      role="dialog"
      aria-label="查找消息"
      className={`flex ${journey6 ? 'max-h-[min(80vh,760px)]' : 'max-h-[min(70vh,600px)]'} min-h-0 flex-col rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-3 shadow-[var(--console-shadow-soft)]`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && !composing.current) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <form
        className="flex items-center gap-2 rounded-lg border border-[var(--console-input-stroke)] px-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!composing.current) void search.search(query, scope, sort);
        }}
      >
        <ShellGlyph name="search" />
        <input
          ref={input}
          aria-label="搜索消息"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
          }}
          className="min-w-0 flex-1 bg-transparent py-2 text-sm text-cafe-black outline-none"
        />
        <button
          type="submit"
          className="rounded-lg px-2 py-1 text-xs text-cafe-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]"
        >
          搜索
        </button>
        <button
          type="button"
          aria-label="关闭消息搜索"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-cafe-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]"
        >
          ×
        </button>
      </form>
      <div role="group" aria-label="检索范围" className="my-2 flex gap-2 text-xs text-cafe-secondary">
        {(['thread', 'global'] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={scope === item}
            onClick={() => selectScope(item)}
            className="rounded-lg px-2 py-1 hover:bg-[var(--console-hover-bg)] aria-pressed:bg-[var(--console-hover-bg)] aria-pressed:font-medium aria-pressed:text-cafe-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]"
          >
            {item === 'thread' ? '当前对话' : '全局'}
          </button>
        ))}
        {journey6 && (
          <>
            <span aria-hidden="true" className="self-center text-cafe-muted">
              ｜
            </span>
            {(['works', 'memory'] as const).map((destination) => (
              <AppTooltip
                key={destination}
                label={
                  destination === 'works' ? `到作品里按名称搜「${query.trim()}」` : `到记忆页里搜「${query.trim()}」`
                }
                detail="看完点「‹ 回到查找」回到这里"
                side="bottom"
              >
                <button
                  type="button"
                  disabled={!query.trim() || !onOpenDestination}
                  className="rounded-lg px-2 py-1 hover:bg-[var(--console-hover-bg)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]"
                  onClick={() =>
                    onOpenDestination?.(destination, {
                      query,
                      scope,
                      sort,
                      scrollTop: scroll.current?.scrollTop ?? 0,
                      status: search.status === 'loading' ? 'idle' : search.status,
                      ...(search.response ? { response: search.response } : {}),
                    })
                  }
                >
                  {destination === 'works' ? '作品 ↗' : '记忆 ↗'}
                </button>
              </AppTooltip>
            ))}
          </>
        )}
      </div>
      <div ref={scroll} data-message-search-scroll className="min-h-0 overflow-auto">
        <MessageSearchResults
          journey6={journey6}
          currentThreadId={threadId}
          status={search.status}
          response={search.response}
          onNavigate={onNavigate}
          onSortChange={selectSort}
          onRetry={() => void search.retry()}
          resolveSpeaker={resolveSpeaker}
        />
      </div>
    </div>
  );
}
