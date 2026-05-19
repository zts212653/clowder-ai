'use client';

import type { SignalArticle, SignalArticleStatus, SignalTier } from '@cat-cafe/shared';
import { useSearchParams } from 'next/navigation';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import {
  createCollection,
  deleteSignalArticle,
  fetchCollections,
  fetchSignalArticle,
  fetchSignalSources,
  fetchSignalStats,
  fetchSignalsInbox,
  type SignalArticleDetail,
  type SignalArticleStats,
  type StudyCollection,
  searchSignals,
  updateCollection,
  updateSignalArticle,
} from '@/utils/signals-api';
import { filterSignalArticles, type SignalArticleFilters } from '@/utils/signals-view';
import { BatchActionBar } from './BatchActionBar';
import { SignalArticleDetail as SignalArticleDetailPanel } from './SignalArticleDetail';
import { SignalArticleList } from './SignalArticleList';
import { SignalFilterBar } from './SignalFilterBar';
import { SignalNav } from './SignalNav';
import { SignalStatsCards } from './SignalStatsCards';
import { StudyTimeline } from './StudyTimeline';

const initialFilters: SignalArticleFilters = {
  query: '',
  status: 'inbox',
  source: 'all',
  tier: 'all',
};

function uniqueSources(items: readonly SignalArticle[]): readonly string[] {
  return Array.from(new Set(items.map((item) => item.source))).sort();
}

function toSignalTier(value: string | undefined): SignalTier | undefined {
  if (!value || value === 'all') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) return undefined;
  return parsed as SignalTier;
}

export function SignalInboxView({ initialReferrerThread = null }: { initialReferrerThread?: string | null }) {
  const ime = useIMEGuard();
  const searchParams = useSearchParams();
  const deepLinkHandled = useRef(false);
  const [items, setItems] = useState<readonly SignalArticle[]>([]);
  const [showServerSearchResults, setShowServerSearchResults] = useState(false);
  const [stats, setStats] = useState<SignalArticleStats | null>(null);
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<SignalArticleDetail | null>(null);
  const [filters, setFilters] = useState<SignalArticleFilters>(initialFilters);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [collections, setCollections] = useState<readonly StudyCollection[]>([]);
  const [allSourceNames, setAllSourceNames] = useState<readonly string[]>([]);

  // Load collections and source config on mount
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

  const toggleBatchSelect = useCallback((articleId: string) => {
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(articleId)) next.delete(articleId);
      else next.add(articleId);
      return next;
    });
  }, []);

  const refreshInbox = useCallback(
    async (statusOverride?: SignalArticleFilters['status']) => {
      setLoading(true);
      setError(null);
      try {
        const activeStatus = statusOverride ?? filters.status;
        const statusParam =
          activeStatus === 'all' ? ('all' as const) : activeStatus === 'inbox' ? undefined : activeStatus;
        const [inboxItems, statsData] = await Promise.all([
          fetchSignalsInbox({ limit: 80, status: statusParam }),
          fetchSignalStats(),
        ]);
        setItems(inboxItems);
        setShowServerSearchResults(false);
        setStats(statsData);
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

  // Deep-link: /signals?article=<id> → switch to 'all' tab and auto-select
  useEffect(() => {
    if (deepLinkHandled.current || loading) return;
    const articleId = searchParams.get('article');
    if (!articleId) return;
    deepLinkHandled.current = true;
    // Switch to 'all' tab so the article is visible regardless of status
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
      const selectedTier = formData.get('tier');
      const statusForSearch = filters.status === 'all' ? undefined : (filters.status as SignalArticleStatus);

      setLoading(true);
      try {
        const result = await searchSignals(query, {
          limit: 80,
          status: statusForSearch,
          source: typeof selectedSource === 'string' && selectedSource !== 'all' ? selectedSource : undefined,
          tier: typeof selectedTier === 'string' ? toSignalTier(selectedTier) : undefined,
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
          // In non-'all' filter mode, remove articles that no longer match
          if (filters.status !== 'all' && updated.status !== filters.status) {
            return next.filter((item) => item.id !== articleId);
          }
          return next;
        });
        setSelectedArticle((current) => (current && current.id === articleId ? updated : current));
        // Refresh stats to reflect the status change
        fetchSignalStats()
          .then(setStats)
          .catch(() => {});
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
      // Refresh stats to exclude the deleted article
      fetchSignalStats()
        .then(setStats)
        .catch(() => {});
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
    }
  }, []);

  return (
    <div className="flex h-full flex-col bg-[var(--console-panel-bg)]">
      <div className="flex flex-1 flex-col overflow-hidden rounded-[18px] bg-[var(--console-shell-bg)] shadow-[var(--console-shadow-soft)] m-3 gap-5 px-9 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-cafe-black">信号</h1>
            <p className="mt-1 text-sm text-cafe-secondary">浏览、筛选和研读信号文章</p>
          </div>
          <SignalNav active="signals" initialReferrerThread={initialReferrerThread} />
        </header>

        <SignalStatsCards stats={stats} />

        {error && (
          <div className="rounded-lg bg-conn-red-bg px-3 py-2 text-sm text-red-700 shadow-[0_1px_3px_rgba(43,33,26,0.06)]">
            请求失败: {error}
          </div>
        )}

        <div className="flex min-h-0 flex-1 gap-[18px]">
          <div className="flex w-[420px] shrink-0 flex-col gap-1 overflow-y-auto rounded-[18px] bg-[var(--console-panel-bg)] p-2">
            <SignalFilterBar
              filters={filters}
              onFilterChange={(patch) => setFilters((cur) => ({ ...cur, ...patch }))}
              onStatusTab={handleStatusTab}
              onSubmit={handleSearchSubmit}
              sources={sources}
              ime={ime}
            />
            <div className="flex items-center justify-between px-2 pb-1">
              <p className="text-xs font-semibold text-cafe-muted">
                {loading ? '加载中...' : `共 ${filteredItems.length} 篇`}
              </p>
              <BatchActionBar
                selectedIds={batchSelected}
                onClear={() => setBatchSelected(new Set())}
                onComplete={() => void refreshInbox()}
              />
            </div>
            <SignalArticleList
              items={filteredItems}
              selectedArticleId={selectedArticleId}
              onSelect={handleSelectArticle}
              onStatusChange={handleStatusChange}
              selectedIds={batchSelected}
              onToggleSelect={toggleBatchSelect}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-[18px] overflow-y-auto">
            <div className="rounded-2xl bg-[var(--console-card-bg)] p-[22px] shadow-[0_10px_28px_rgba(43,33,26,0.04)]">
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
            <StudyTimeline />
          </div>
        </div>
      </div>
    </div>
  );
}
