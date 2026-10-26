'use client';

import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { ShellGlyph } from '../shell/ShellIcons';
import { useShellPresentation } from '../shell/shell-presentation';
import { MessageSearchResults } from './MessageSearchResults';
import { useMessageSearch } from './useMessageSearch';

export function MessageSearchPanel({
  threadId,
  onClose,
  onNavigate,
  resolveSpeaker,
}: {
  threadId: string;
  onClose: () => void;
  onNavigate: (result: MessageSearchResult, response: MessageSearchResponse) => void;
  resolveSpeaker?: (speaker: string) => string;
}) {
  const journey6 = useShellPresentation() === 'v2';
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'thread' | 'global'>('thread');
  const [sort, setSort] = useState<'time' | 'relevance'>('time');
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const search = useMessageSearch(threadId);
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
      </div>
      <div data-message-search-scroll className="min-h-0 overflow-auto">
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
