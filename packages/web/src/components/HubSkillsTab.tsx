'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { UploadSkillModal } from './UploadSkillModal';

interface SearchSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  stars?: number;
  repo: { githubOwner: string; githubRepoName: string };
  isInstalled: boolean;
}

interface SearchResult {
  skills: SearchSkill[];
  total: number;
  page: number;
  hasMore: boolean;
}

type InstallStatus = 'installing' | 'success' | string;

function InstallButton({
  slug,
  owner,
  repo,
  status,
  onInstall,
}: {
  slug: string;
  owner: string;
  repo: string;
  status: InstallStatus | undefined;
  onInstall: (owner: string, repo: string, skill: string) => void;
}) {
  if (status === 'installing') {
    return (
      <button
        type="button"
        disabled
        className="px-2 py-1 text-[10px] font-medium rounded bg-gray-100 text-gray-400 cursor-not-allowed"
      >
        安装中...
      </button>
    );
  }
  if (status === 'success') {
    return (
      <button
        type="button"
        disabled
        className="px-2 py-1 text-[10px] font-medium rounded bg-green-100 text-green-600 cursor-default"
      >
        安装成功
      </button>
    );
  }
  if (typeof status === 'string' && status !== 'installing' && status !== 'success') {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <button
          type="button"
          onClick={() => onInstall(owner, repo, slug)}
          className="px-2 py-1 text-[10px] font-medium rounded bg-red-50 text-red-500 hover:bg-red-100"
        >
          安装失败
        </button>
        <span className="text-[9px] text-red-400 max-w-[180px] text-right leading-tight">{status}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onInstall(owner, repo, slug)}
      className="px-2 py-1 text-[10px] font-medium rounded bg-blue-50 text-blue-600 hover:bg-blue-100"
    >
      安装
    </button>
  );
}

function SkillList({
  results,
  installStatus,
  onInstall,
  onLoadMore,
  loadingMore,
  showPagination = true,
}: {
  results: SearchResult;
  installStatus: Map<string, InstallStatus>;
  onInstall: (owner: string, repo: string, skill: string) => void;
  onLoadMore: () => void;
  loadingMore: boolean;
  showPagination?: boolean;
}) {
  if (results.skills.length === 0) {
    return <p className="text-xs text-gray-400 py-2">未找到匹配的 skill</p>;
  }

  return (
    <div>
      <p className="text-[10px] text-gray-400 mb-2">
        共 {results.total} 条{showPagination && `，第 ${results.page} 页`}
      </p>
      <div className="space-y-1.5">
        {results.skills.map((skill) => (
          <div
            key={skill.id}
            className="flex items-center justify-between rounded border border-gray-100 bg-white px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <code className="font-mono text-blue-600 text-[11px] font-semibold">{skill.name}</code>
                {skill.stars !== undefined && <span className="text-[10px] text-gray-400">{skill.stars}</span>}
                {skill.isInstalled && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-600">
                    已安装
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray-500 truncate mt-0.5">{skill.description}</p>
            </div>
            <div className="ml-3 shrink-0">
              {skill.isInstalled ? (
                <span className="text-[10px] text-gray-400">-</span>
              ) : (
                <InstallButton
                  slug={skill.slug}
                  owner={skill.repo.githubOwner}
                  repo={skill.repo.githubRepoName}
                  status={installStatus.get(skill.slug)}
                  onInstall={onInstall}
                />
              )}
            </div>
          </div>
        ))}
      </div>
      {results.hasMore && showPagination && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="mt-3 w-full py-1.5 text-[11px] font-medium rounded border border-gray-200 text-blue-600 hover:bg-blue-50 disabled:opacity-50"
        >
          {loadingMore ? '加载中...' : `加载更多（第 ${results.page + 1} 页）`}
        </button>
      )}
    </div>
  );
}

export function HubSkillsTab() {
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Trending state
  const [trendingResults, setTrendingResults] = useState<SearchResult | null>(null);
  const [trendingLoading, setTrendingLoading] = useState(false);

  // Upload modal state
  const [showUpload, setShowUpload] = useState(false);

  // Install status
  const [installStatus, setInstallStatus] = useState<Map<string, InstallStatus>>(new Map());
  const statusTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const setInstallStatusWithTimer = useCallback((slug: string, status: InstallStatus) => {
    setInstallStatus((prev) => new Map(prev).set(slug, status));
    const existing = statusTimers.current.get(slug);
    if (existing) clearTimeout(existing);
    if (typeof status === 'string' && status !== 'installing' && status !== 'success') {
      const timer = setTimeout(() => {
        setInstallStatus((prev) => {
          const next = new Map(prev);
          next.delete(slug);
          return next;
        });
        statusTimers.current.delete(slug);
      }, 3000);
      statusTimers.current.set(slug, timer);
    }
  }, []);

  // Toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  // Debounce
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timers
  useEffect(() => {
    const timers = statusTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  // Load trending on mount
  useEffect(() => {
    setTrendingLoading(true);
    apiFetch('/api/skills/trending')
      .then((res) => res.ok && res.json())
      .then((data) => data && setTrendingResults(data as SearchResult))
      .catch(() => {})
      .finally(() => setTrendingLoading(false));
  }, []);

  // Execute search immediately
  const executeSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await apiFetch(`/api/skills/search?q=${encodeURIComponent(query.trim())}&page=1&limit=20`);
      if (!res.ok) {
        setSearchError('搜索失败');
        return;
      }
      setSearchResults((await res.json()) as SearchResult);
    } catch {
      setSearchError('网络错误');
    } finally {
      setSearchLoading(false);
    }
  }, []);

  // Search with debounce (input handler)
  const handleSearchInput = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (!value.trim()) {
        setSearchResults(null);
        setSearchError(null);
        return;
      }
      debounceTimer.current = setTimeout(() => executeSearch(value), 300);
    },
    [executeSearch],
  );

  // Load more (pagination)
  const handleLoadMore = useCallback(async () => {
    if (!searchResults || !searchQuery.trim()) return;
    const nextPage = searchResults.page + 1;
    setLoadingMore(true);
    try {
      const res = await apiFetch(
        `/api/skills/search?q=${encodeURIComponent(searchQuery.trim())}&page=${nextPage}&limit=20`,
      );
      if (res.ok) {
        const data = (await res.json()) as SearchResult;
        setSearchResults({ ...data, skills: [...searchResults.skills, ...data.skills] });
      }
    } catch {
      // ignore
    } finally {
      setLoadingMore(false);
    }
  }, [searchResults, searchQuery]);

  // Install
  const handleInstall = useCallback(
    async (owner: string, repo: string, skill: string) => {
      setInstallStatusWithTimer(skill, 'installing');
      try {
        const res = await apiFetch('/api/skills/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner, repo, skill }),
        });
        if (res.ok) {
          setInstallStatusWithTimer(skill, 'success');
          showToast(`"${skill}" 安装成功`, 'success');
        } else {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          const msg = payload.error ?? `安装失败 (${res.status})`;
          setInstallStatusWithTimer(skill, msg);
          showToast(msg, 'error');
        }
      } catch {
        setInstallStatusWithTimer(skill, '网络错误，请重试');
        showToast('网络错误，安装失败', 'error');
      }
    },
    [setInstallStatusWithTimer, showToast],
  );

  return (
    <div className="space-y-4">
      {/* Toast */}
      {toast && (
        <div
          className={`rounded-lg px-3 py-2 text-xs font-medium ${
            toast.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Upload button */}
      <button
        type="button"
        onClick={() => setShowUpload(true)}
        className="w-full py-2 text-xs font-medium rounded-lg border border-dashed border-blue-300 text-blue-600 hover:bg-blue-50 transition-colors"
      >
        + 上传 Skill
      </button>

      {/* Upload modal */}
      <UploadSkillModal
        open={showUpload}
        onClose={() => setShowUpload(false)}
        onSuccess={() => {
          showToast('Skill 上传成功', 'success');
        }}
      />

      {/* Search */}
      <section className="rounded-lg border border-gray-200 bg-gray-50/70 p-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && executeSearch(searchQuery)}
            placeholder="搜索 SkillHub skill..."
            className="flex-1 text-xs px-3 py-1.5 rounded border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-blue-300"
          />
          <button
            type="button"
            onClick={() => executeSearch(searchQuery)}
            disabled={searchLoading || !searchQuery.trim()}
            className="px-3 py-1.5 text-xs font-medium rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {searchLoading ? '搜索中...' : '搜索'}
          </button>
        </div>
        {searchError && <p className="text-[11px] text-red-500 mt-2">{searchError}</p>}
        {searchResults && (
          <div className="mt-3">
            <SkillList
              results={searchResults}
              installStatus={installStatus}
              onInstall={handleInstall}
              onLoadMore={handleLoadMore}
              loadingMore={loadingMore}
            />
          </div>
        )}
      </section>

      {/* Trending — always expanded */}
      <section className="rounded-lg border border-gray-200 bg-gray-50/70 p-3">
        <h3 className="text-xs font-semibold text-gray-700 mb-2">热门推荐</h3>
        {trendingLoading && <p className="text-[11px] text-gray-400">加载中...</p>}
        {trendingResults && (
          <SkillList
            results={trendingResults}
            installStatus={installStatus}
            onInstall={handleInstall}
            onLoadMore={() => {}}
            loadingMore={false}
            showPagination={false}
          />
        )}
      </section>
    </div>
  );
}
