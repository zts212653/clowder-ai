'use client';
import type { MatterCatalog } from '@cat-cafe/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MATTER_MEMORY_CHANGED } from '@/hooks/matter-memory-events';
import { MemoryMatterActions } from './MemoryMatterActions';
import { MemoryReadState } from './MemoryReadState';
import { useMemoryPageTail } from './use-memory-page-tail';
import { useMemoryRead } from './use-memory-read';

export function MemoryMatters() {
  const [query, setQuery] = useState('');
  const path = `/api/memory/matters?limit=12${query ? `&query=${encodeURIComponent(query)}` : ''}`;
  const list = useMemoryRead<MatterCatalog>(path);
  const {
    data: more,
    loading,
    error: failed,
    cursor,
    loadMore,
  } = useMemoryPageTail(path, list.data, (previous, page) => ({
    ...page,
    items: [...(previous?.items ?? []), ...page.items],
  }));
  useEffect(() => {
    window.addEventListener(MATTER_MEMORY_CHANGED, list.retry);
    return () => window.removeEventListener(MATTER_MEMORY_CHANGED, list.retry);
  }, [list.retry]);
  const entries = [...(list.data?.items ?? []), ...(more?.items ?? [])];
  return (
    <section className="space-y-4" aria-label="事情">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">事情</h2>
        <input
          aria-label="查找事情"
          placeholder="查找事情"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] px-3 py-2 text-sm"
        />
      </div>
      <MemoryReadState
        loading={list.loading}
        error={list.error}
        empty={!entries.length}
        noun="事情"
        retry={list.retry}
      />
      {entries.map((item) => (
        <article
          key={item.matterId}
          className="space-y-3 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4"
        >
          {'unavailable' in item ? (
            <p className="text-sm text-cafe-muted">来源已不可用</p>
          ) : (
            <>
              <Link
                href={`/memory?matter=${encodeURIComponent(item.matterId)}`}
                className="shell-focusable font-medium hover:underline"
              >
                {item.title} ›
              </Link>
              {item.description && <p className="whitespace-pre-wrap text-sm text-cafe-muted">{item.description}</p>}
              <p className="text-xs text-cafe-muted">
                {item.entryCount} 条原话{item.status === 'retired' ? ' · 已不再使用' : ''}
              </p>
            </>
          )}
          <MemoryMatterActions matter={item} onChanged={list.retry} />
        </article>
      ))}
      {(cursor || failed) && (
        <button
          type="button"
          className="shell-focusable text-sm text-cafe-accent underline"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          {loading ? '正在读取…' : failed ? '重试加载' : '加载更多'}
        </button>
      )}
    </section>
  );
}
