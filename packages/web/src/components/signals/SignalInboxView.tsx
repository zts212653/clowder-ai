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
    <div className="min-h-screen bg-gradient-to-b from-cocreator-bg via-cafe-white to-cafe-white">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6">
        <header className="rounded-2xl border border-cocreator-light bg-cafe-surface p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-cafe-black">Signal Inbox</h1>
              <p className="text-sm text-cafe-secondary">浏览、筛选和管理 F21 信号文章</p>
            </div>
            <SignalNav active="signals" initialReferrerThread={initialReferrerThread} />
          </div>
        </header>

        <div className="rounded-2xl border border-cafe bg-cafe-surface p-4 shadow-sm space-y-3">
          <div className="flex gap-1">
            {(
              [
                ['inbox', 'Inbox'],
                ['starred', '收藏'],
                ['read', '已读'],
                ['archived', '归档'],
                ['all', '全部'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => handleStatusTab(key)}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  filters.status === key
                    ? 'bg-cocreator-primary text-white'
                    : 'text-cafe-secondary hover:bg-cafe-surface-elevated'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <form onSubmit={handleSearchSubmit} className="grid gap-2 md:grid-cols-4">
            <input
              value={filters.query}
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && ime.isComposing()) event.preventDefault();
              }}
              placeholder="搜索标题、来源、标签..."
              className="rounded-lg border border-cafe px-3 py-2 text-sm md:col-span-2"
            />
            <select
              value={filters.tier}
              onChange={(event) =>
                setFilters((current) => ({ ...current, tier: event.target.value as SignalArticleFilters['tier'] }))
              }
              name="tier"
              className="rounded-lg border border-cafe px-3 py-2 text-sm"
            >
              <option value="all">Tier: 全部</option>
              <option value="1">Tier 1</option>
              <option value="2">Tier 2</option>
              <option value="3">Tier 3</option>
              <option value="4">Tier 4</option>
            </select>
            <select
              value={filters.source}
              onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value }))}
              name="source"
              className="rounded-lg border border-cafe px-3 py-2 text-sm"
            >
              <option value="all">来源: 全部</option>
              {sources.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-lg bg-cocreator-primary px-3 py-2 text-sm font-semibold text-white hover:bg-cocreator-dark md:col-span-4"
            >
              搜索
            </button>
          </form>
        </div>

        <SignalStatsCards stats={stats} />

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            请求失败: {error}
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
          <div className="space-y-2">
            <div className="text-sm text-cafe-secondary">{loading ? '加载中...' : `共 ${filteredItems.length} 篇`}</div>
            <BatchActionBar
              selectedIds={batchSelected}
              onClear={() => setBatchSelected(new Set())}
              onComplete={() => void refreshInbox()}
            />
            <SignalArticleList
              items={filteredItems}
              selectedArticleId={selectedArticleId}
              onSelect={handleSelectArticle}
              onStatusChange={handleStatusChange}
              selectedIds={batchSelected}
              onToggleSelect={toggleBatchSelect}
            />
          </div>
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
        </section>

        <StudyTimeline />
      </main>
    </div>
  );
}
