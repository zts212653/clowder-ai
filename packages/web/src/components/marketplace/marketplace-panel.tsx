'use client';

import type { MarketplaceArtifactKind } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMarketplaceStore } from '@/stores/marketplaceStore';
import { HubIcon } from '../hub-icons';
import { ArtifactCard } from './artifact-card';
import { InstallPlanDetail } from './install-plan-detail';
import { MarketplaceSearch } from './marketplace-search';

const PAGE_SIZE = 12;

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="animate-pulse rounded-xl bg-[var(--console-card-bg)] p-4">
          <div className="h-4 w-1/3 rounded bg-[var(--console-border-soft)]" />
          <div className="mt-2 h-3 w-2/3 rounded bg-[var(--console-border-soft)]" />
          <div className="mt-1.5 h-3 w-1/2 rounded bg-[var(--console-border-soft)]" />
        </div>
      ))}
    </div>
  );
}

export function MarketplacePanel({
  artifactKinds,
  projectPath,
  onInstalled,
}: {
  artifactKinds?: MarketplaceArtifactKind[];
  projectPath?: string;
  onInstalled?: () => void;
} = {}) {
  const setArtifactKindsFilter = useMarketplaceStore((s) => s.setArtifactKindsFilter);
  useEffect(() => {
    if (artifactKinds) setArtifactKindsFilter(artifactKinds);
    return () => setArtifactKindsFilter([]);
  }, [artifactKinds, setArtifactKindsFilter]);

  const results = useMarketplaceStore((s) => s.results);
  const selectedResult = useMarketplaceStore((s) => s.selectedResult);
  const installPlan = useMarketplaceStore((s) => s.installPlan);
  const loading = useMarketplaceStore((s) => s.loading);
  const error = useMarketplaceStore((s) => s.error);
  const query = useMarketplaceStore((s) => s.query);
  const selectResult = useMarketplaceStore((s) => s.selectResult);
  const getInstallPlan = useMarketplaceStore((s) => s.getInstallPlan);
  const clearSelection = useMarketplaceStore((s) => s.clearSelection);
  const search = useMarketplaceStore((s) => s.search);
  const browse = useMarketplaceStore((s) => s.browse);

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reset visible count when results change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [results]);

  // Auto-browse on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only
  useEffect(() => {
    if (!query && results.length === 0 && !loading) browse();
  }, []);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= results.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((n) => Math.min(n + PAGE_SIZE, results.length));
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visibleCount, results.length]);

  const handleSelect = useCallback(
    (result: (typeof results)[number]) => {
      selectResult(result);
      getInstallPlan(result.ecosystem, result.artifactId);
    },
    [selectResult, getInstallPlan],
  );

  const handleRetry = useCallback(() => {
    if (query) search(query);
    else browse();
  }, [browse, query, search]);

  useEffect(() => {
    return () => clearSelection();
  }, [clearSelection]);

  if (selectedResult && installPlan) {
    return (
      <InstallPlanDetail
        result={selectedResult}
        plan={installPlan}
        projectPath={projectPath}
        onBack={clearSelection}
        onInstalled={onInstalled}
      />
    );
  }

  const visibleResults = results.slice(0, visibleCount);

  return (
    <div className="space-y-4">
      <MarketplaceSearch />

      {loading && <LoadingSkeleton />}

      {error && (
        <div className="rounded-[20px] border border-conn-red-ring bg-conn-red-bg p-3 text-sm text-conn-red-text">
          <p>{error}</p>
          <button type="button" onClick={handleRetry} className="mt-1 text-xs font-medium text-conn-red-text underline">
            重试
          </button>
        </div>
      )}

      {!loading && !error && results.length > 0 && (
        <div className="space-y-2.5">
          {visibleResults.map((r) => (
            <ArtifactCard key={`${r.ecosystem}:${r.artifactId}`} result={r} onSelect={handleSelect} />
          ))}
          {visibleCount < results.length && <div ref={sentinelRef} className="h-1" />}
        </div>
      )}

      {!loading && !error && query && results.length === 0 && (
        <div className="py-8 text-center text-sm text-cafe-muted">未找到匹配 &ldquo;{query}&rdquo; 的能力</div>
      )}

      {!loading && !error && !query && results.length === 0 && (
        <div className="flex flex-col items-center py-12 text-cafe-muted">
          <HubIcon name="search" className="mb-3 h-8 w-8 opacity-30" />
          <p className="text-sm">搜索关键词，发现能力</p>
          <p className="mt-1 text-xs">支持 Claude · Codex · OpenClaw · Antigravity 四大生态</p>
        </div>
      )}
    </div>
  );
}
