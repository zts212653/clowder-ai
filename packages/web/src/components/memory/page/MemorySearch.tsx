'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { verifyMessageNavigationSource } from '@/components/message-search/verify-message-navigation-source';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { MemorySearchDetail, type SearchDetail } from './MemorySearchDetail';
import { MemorySearchFeedback } from './MemorySearchFeedback';
import { MemorySearchResult } from './MemorySearchResult';
import { type MemorySearchRow, SEARCH_LABELS } from './memory-search-types';
import type { MemorySearchController } from './use-memory-search';

export function MemorySearchBox({ search }: { search: MemorySearchController }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        search.submit();
      }}
      className="flex min-w-0 gap-2"
    >
      <input
        aria-label="搜索记忆和资料"
        placeholder="搜索记忆、文档和对话"
        value={search.input}
        onChange={(event) => search.setInput(event.target.value)}
        maxLength={2000}
        className="min-w-0 flex-1 rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] px-3 py-2 text-sm md:w-60"
      />
      <button
        type="submit"
        aria-label="搜索"
        title="回车搜索"
        disabled={!search.input.trim()}
        className="rounded-lg px-3 py-2 text-cafe-secondary hover:bg-cafe-surface-sunken disabled:opacity-50"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
      </button>
    </form>
  );
}

export function MemorySearch({ search }: { search: MemorySearchController }) {
  const { read } = search;
  const router = useRouter();
  const host = useRef<HTMLElement>(null);
  const scroll = useRef(0);
  const [detail, setDetail] = useState<SearchDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const navigation = useRef<AbortController | null>(null);
  useEffect(() => () => navigation.current?.abort(), []);
  const open = async (row: MemorySearchRow) => {
    const target = row.destination;
    if (!target) return;
    if (target.kind !== 'message') {
      scroll.current = host.current?.closest('main')?.scrollTop ?? 0;
      setDetail(target);
      return;
    }
    navigation.current?.abort();
    const controller = new AbortController();
    navigation.current = controller;
    setNotice('正在核对来源…');
    const admitted = await verifyMessageNavigationSource(target, controller.signal);
    if (controller.signal.aborted) return;
    if (admitted.status !== 'available') {
      setNotice('暂时读不到这条消息，重新搜索后再试。');
      return;
    }
    handleTeleportEvent(target, null, {
      pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
      scrollToMessage,
    });
  };
  useEffect(() => {
    const main = host.current?.closest('main');
    if (main) main.scrollTop = detail ? 0 : scroll.current;
  }, [detail]);
  const back = () => setDetail(null);
  const rows = read.data?.groups.flatMap((g) => g.results) ?? [];
  return (
    <section ref={host} aria-label="记忆搜索结果" className="min-w-0 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-display-sm font-medium">“{search.query}” 的搜索结果</h1>
          <p className="mt-2 text-sm text-cafe-muted">记忆、文档和对话一起搜；关系图从每条结果的“⋯”打开。</p>
        </div>
        <button type="button" onClick={search.close} className="text-compact text-cafe-accent underline">
          关闭搜索
        </button>
      </header>
      {detail ? (
        <MemorySearchDetail
          target={detail}
          close={back}
          reload={() => {
            back();
            read.retry();
          }}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {(['summary', 'raw'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={search.depth === value}
                onClick={() => search.setDepth(value)}
                className={`rounded-lg px-3 py-2 text-compact ${search.depth === value ? 'bg-cafe-surface-sunken font-medium' : 'text-cafe-muted'}`}
              >
                {value === 'summary' ? '只看摘要' : '包含原文'}
              </button>
            ))}
          </div>
          <fieldset className="flex flex-wrap gap-2" aria-label="搜索结果类型">
            {(Object.keys(SEARCH_LABELS) as Array<keyof typeof SEARCH_LABELS>).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={search.type === value}
                onClick={() => search.setType(value)}
                className={`rounded-lg px-3 py-2 text-compact ${search.type === value ? 'bg-cafe-surface-sunken font-medium' : 'text-cafe-muted'}`}
              >
                {SEARCH_LABELS[value]}
              </button>
            ))}
          </fieldset>
          {read.loading ? (
            <output className="text-sm text-cafe-muted">正在搜索…</output>
          ) : read.error || read.data?.readStatus === 'unavailable' ? (
            <p role="alert" className="text-sm text-cafe-muted">
              暂时读不到搜索结果{' '}
              <button type="button" onClick={read.retry} className="ml-2 text-cafe-accent underline">
                重试
              </button>
            </p>
          ) : (
            <>
              {read.data && <MemorySearchFeedback groups={read.data.groups} retry={read.retry} />}
              {rows.length > 0 && <p className="text-compact text-cafe-muted">本次已核对 {rows.length} 条结果</p>}
              <div className="divide-y divide-cafe-subtle rounded-xl bg-[var(--console-card-bg)] px-4">
                {rows.map((row) => (
                  <MemorySearchResult
                    key={row.id}
                    row={row}
                    onOpen={(r) => void open(r)}
                    onGraph={(graph) => {
                      scroll.current = host.current?.closest('main')?.scrollTop ?? 0;
                      setDetail({ kind: 'graph', ...graph });
                    }}
                  />
                ))}
              </div>
            </>
          )}
          {notice && <output className="block text-sm text-cafe-muted">{notice}</output>}
        </>
      )}
    </section>
  );
}
