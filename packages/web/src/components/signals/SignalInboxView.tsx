'use client';

import type { SignalArticle, SignalArticleStatus } from '@cat-cafe/shared';
import { useSearchParams } from 'next/navigation';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import {
  createCollection,
  deleteSignalArticle,
  fetchCollections,
  fetchSignalArticle,
  fetchSignalSources,
  fetchSignalsInbox,
  type SignalArticleDetail,
  type StudyCollection,
  searchSignals,
  updateCollection,
  updateSignalArticle,
} from '@/utils/signals-api';
import { filterSignalArticles, type SignalArticleFilters } from '@/utils/signals-view';
import { SignalArticleDetail as SignalArticleDetailPanel } from './SignalArticleDetail';
import { SignalArticleList } from './SignalArticleList';
import { SignalNav } from './SignalNav';

const initialFilters: SignalArticleFilters = {
  query: '',
  status: 'inbox',
  source: 'all',
  tier: 'all',
};

function uniqueSources(items: readonly SignalArticle[]): readonly string[] {
  return Array.from(new Set(items.map((item) => item.source))).sort();
}

export function SignalInboxView({ initialReferrerThread = null }: { initialReferrerThread?: string | null }) {
  const ime = useIMEGuard();
  const searchParams = useSearchParams();
  const deepLinkHandled = useRef(false);
  const [items, setItems] = useState<readonly SignalArticle[]>([]);
  const [showServerSearchResults, setShowServerSearchResults] = useState(false);
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<SignalArticleDetail | null>(null);
  const [filters, setFilters] = useState<SignalArticleFilters>(initialFilters);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collections, setCollections] = useState<readonly StudyCollection[]>([]);
  const [allSourceNames, setAllSourceNames] = useState<readonly string[]>([]);

  useEffect(() => {
    fetchCollections()
      .then(setCollections)
      .catch(() => {});
    fetchSignalSources()
      .then((sources) => setAllSourceNames(sources.map((s) => s.name).sort()))
      .catch(() => {});
  }, []);

  const handleAddToCollection = useCallback(
    async (collectionId: string) => {
      if (!selectedArticle) return;
      const col = collections.find((c) => c.id === collectionId);
      if (!col) return;
      const updated = await updateCollection(collectionId, {
        articleIds: [...col.articleIds, selectedArticle.id],
      });
      setCollections((prev) => prev.map((c) => (c.id === collectionId ? updated : c)));
    },
    [selectedArticle, collections],
  );

  const handleCreateCollection = useCallback(
    async (name: string) => {
      const col = await createCollection(name, selectedArticle ? [selectedArticle.id] : []);
      setCollections((prev) => [...prev, col]);
    },
    [selectedArticle],
  );

  const refreshInbox = useCallback(
    async (statusOverride?: SignalArticleFilters['status']) => {
      setLoading(true);
      setError(null);
      try {
        const activeStatus = statusOverride ?? filters.status;
        const statusParam =
          activeStatus === 'all' ? ('all' as const) : activeStatus === 'inbox' ? undefined : activeStatus;
        const inboxItems = await fetchSignalsInbox({ limit: 80, status: statusParam });
        setItems(inboxItems);
        setShowServerSearchResults(false);
      } catch (fetchError) {
        setError(fetchError instanceof Error ? fetchError.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [filters.status],
  );

  useEffect(() => {
    void refreshInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, [refreshInbox]);

  useEffect(() => {
    if (deepLinkHandled.current || loading) return;
    const articleId = searchParams.get('article');
    if (!articleId) return;
    deepLinkHandled.current = true;
    setFilters((current) => ({ ...current, status: 'all' }));
    void refreshInbox('all').then(() => {
      setSelectedArticleId(articleId);
      setDetailLoading(true);
      fetchSignalArticle(articleId)
        .then(setSelectedArticle)
        .catch(() => {})
        .finally(() => setDetailLoading(false));
    });
  }, [loading, searchParams, refreshInbox]);

  const handleStatusTab = useCallback(
    (status: SignalArticleFilters['status']) => {
      setFilters((current) => ({ ...current, status }));
      void refreshInbox(status);
    },
    [refreshInbox],
  );

  const filteredItems = useMemo(
    () => (showServerSearchResults ? items : filterSignalArticles(items, filters)),
    [showServerSearchResults, items, filters],
  );

  useEffect(() => {
    if (selectedArticleId || filteredItems.length === 0 || deepLinkHandled.current) return;
    const first = filteredItems[0];
    if (!first) return;
    setSelectedArticleId(first.id);
    setDetailLoading(true);
    fetchSignalArticle(first.id)
      .then(setSelectedArticle)
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  }, [filteredItems, selectedArticleId]);
  const sources = allSourceNames.length > 0 ? allSourceNames : uniqueSources(items);

  const handleSearchSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      const query = filters.query.trim();
      if (query.length === 0) {
        await refreshInbox();
        return;
      }
      const formData = new FormData(event.currentTarget);
      const selectedSource = formData.get('source');
      const statusForSearch = filters.status === 'all' ? undefined : (filters.status as SignalArticleStatus);

      setLoading(true);
      try {
        const result = await searchSignals(query, {
          limit: 80,
          status: statusForSearch,
          source: typeof selectedSource === 'string' && selectedSource !== 'all' ? selectedSource : undefined,
          tier: undefined,
        });
        setItems(result.items);
        setShowServerSearchResults(true);
        setSelectedArticleId(null);
        setSelectedArticle(null);
      } catch (searchError) {
        setError(searchError instanceof Error ? searchError.message : '搜索失败');
      } finally {
        setLoading(false);
      }
    },
    [filters.query, filters.status, refreshInbox],
  );

  const handleSelectArticle = useCallback(async (article: SignalArticle) => {
    setSelectedArticleId(article.id);
    setDetailLoading(true);
    setError(null);
    try {
      const detail = await fetchSignalArticle(article.id);
      setSelectedArticle(detail);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '加载详情失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleStatusChange = useCallback(
    async (articleId: string, status: SignalArticleStatus) => {
      setError(null);
      try {
        const updated = await updateSignalArticle(articleId, { status });
        setItems((current) => {
          const next = current.map((item) => (item.id === articleId ? updated : item));
          if (filters.status !== 'all' && updated.status !== filters.status) {
            return next.filter((item) => item.id !== articleId);
          }
          return next;
        });
        setSelectedArticle((current) => (current && current.id === articleId ? updated : current));
      } catch (updateError) {
        setError(updateError instanceof Error ? updateError.message : '更新文章失败');
      }
    },
    [filters.status],
  );

  const handleTagsChange = useCallback(async (articleId: string, tags: readonly string[]) => {
    setError(null);
    try {
      const updated = await updateSignalArticle(articleId, { tags });
      setItems((current) => current.map((item) => (item.id === articleId ? updated : item)));
      setSelectedArticle((current) => (current && current.id === articleId ? updated : current));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '更新标签失败');
    }
  }, []);

  const handleNoteChange = useCallback(async (articleId: string, note: string) => {
    setError(null);
    try {
      const updated = await updateSignalArticle(articleId, { note });
      setItems((current) => current.map((item) => (item.id === articleId ? updated : item)));
      setSelectedArticle((current) => (current && current.id === articleId ? updated : current));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '保存备注失败');
    }
  }, []);

  const handleDelete = useCallback(async (articleId: string) => {
    setError(null);
    try {
      await deleteSignalArticle(articleId);
      setItems((current) => current.filter((item) => item.id !== articleId));
      setSelectedArticle(null);
      setSelectedArticleId(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
    }
  }, []);

  return (
    <div className="flex h-full flex-col bg-[var(--console-panel-bg)]">
      <div className="flex flex-1 flex-col overflow-hidden rounded-[18px] bg-[var(--console-shell-bg)] shadow-[var(--console-shadow-soft)] m-3 gap-5 px-9 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-cafe">信号</h1>
            <p className="mt-1 text-[13px] text-cafe-secondary">浏览、筛选和研读来自信源的文章</p>
          </div>
        </header>

        <div className="flex h-[38px] items-center gap-2">
          <SignalNav active="signals" initialReferrerThread={initialReferrerThread} />
        </div>

        {error && (
          <div className="console-status-chip" data-status="error">
            请求失败: {error}
          </div>
        )}

        <div className="flex min-h-0 flex-1 gap-[18px]">
          <div className="flex w-[420px] shrink-0 flex-col gap-1 overflow-y-auto rounded-[18px] bg-[var(--console-panel-bg)] p-2">
            <form onSubmit={handleSearchSubmit} className="flex flex-wrap items-center gap-1.5 px-1 pb-1">
              <div className="flex flex-1 items-center gap-1.5 rounded-lg bg-[var(--console-card-bg)] px-2.5 h-8 shadow-[0_1px_3px_rgba(43,33,26,0.06)]">
                <svg
                  className="h-[13px] w-[13px] text-cafe-muted"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  value={filters.query}
                  onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                  onCompositionStart={ime.onCompositionStart}
                  onCompositionEnd={ime.onCompositionEnd}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && ime.isComposing()) event.preventDefault();
                  }}
                  placeholder="搜索信号..."
                  className="min-w-0 flex-1 bg-transparent text-xs text-cafe outline-none placeholder:text-cafe-muted"
                />
              </div>
              <select
                value={filters.status}
                onChange={(event) => handleStatusTab(event.target.value as SignalArticleFilters['status'])}
                className="h-8 appearance-none rounded-lg bg-[var(--console-card-bg)] px-2 text-[11px] text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] outline-none"
                name="status"
              >
                <option value="inbox">Inbox</option>
                <option value="starred">收藏</option>
                <option value="read">已读</option>
                <option value="archived">归档</option>
                <option value="all">全部</option>
              </select>
              <select
                value={filters.source}
                onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value }))}
                name="source"
                className="h-8 appearance-none rounded-lg bg-[var(--console-card-bg)] px-2 text-[11px] text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] outline-none"
              >
                <option value="all">全部来源</option>
                {sources.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
            </form>
            <p className="px-2 pb-1 text-xs font-semibold text-cafe-muted">共 {filteredItems.length} 篇</p>
            <SignalArticleList
              items={filteredItems}
              selectedArticleId={selectedArticleId}
              onSelect={handleSelectArticle}
              onStatusChange={handleStatusChange}
            />
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto rounded-[20px] bg-[var(--console-card-bg)] p-[22px] shadow-[0_10px_28px_rgba(43,33,26,0.04)]">
            <SignalArticleDetailPanel
              article={selectedArticle}
              isLoading={detailLoading}
              onStatusChange={handleStatusChange}
              onTagsChange={handleTagsChange}
              onNoteChange={handleNoteChange}
              onDelete={handleDelete}
              collections={collections}
              onAddToCollection={handleAddToCollection}
              onCreateCollection={handleCreateCollection}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
