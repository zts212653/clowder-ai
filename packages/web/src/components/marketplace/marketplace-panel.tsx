'use client';

import { useCallback, useEffect } from 'react';
import { useMarketplaceStore } from '@/stores/marketplaceStore';
import { HubIcon } from '../hub-icons';
import { ArtifactCard } from './artifact-card';
import { InstallPlanDetail } from './install-plan-detail';
import { MarketplaceSearch } from './marketplace-search';

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="animate-pulse rounded-xl border border-cafe-border bg-white p-4">
          <div className="h-4 w-1/3 rounded bg-cafe-border" />
          <div className="mt-2 h-3 w-2/3 rounded bg-cafe-border/60" />
          <div className="mt-1.5 h-3 w-1/2 rounded bg-cafe-border/40" />
        </div>
      ))}
    </div>
  );
}

export function MarketplacePanel() {
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

  const handleSelect = useCallback(
    (result: (typeof results)[number]) => {
      selectResult(result);
      getInstallPlan(result.ecosystem, result.artifactId);
    },
    [selectResult, getInstallPlan],
  );

  const handleRetry = useCallback(() => {
    if (query) search(query);
  }, [query, search]);

  useEffect(() => {
    return () => clearSelection();
  }, [clearSelection]);

  if (selectedResult && installPlan) {
    return <InstallPlanDetail result={selectedResult} plan={installPlan} onBack={clearSelection} />;
  }

  return (
    <div className="space-y-4">
      <MarketplaceSearch />

      {loading && <LoadingSkeleton />}

      {error && (
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
          <p>{error}</p>
          <button onClick={handleRetry} className="mt-1 text-xs font-medium text-red-700 underline">
            重试
          </button>
        </div>
      )}

      {!loading && !error && query && results.length > 0 && (
        <>
          <p className="text-xs text-cafe-muted">找到 {results.length} 个结果</p>
          <div className="space-y-2">
            {results.map((r) => (
              <ArtifactCard key={`${r.ecosystem}:${r.artifactId}`} result={r} onSelect={handleSelect} />
            ))}
          </div>
        </>
      )}

      {!loading && !error && query && results.length === 0 && (
        <div className="py-8 text-center text-sm text-cafe-muted">未找到匹配 &ldquo;{query}&rdquo; 的能力</div>
      )}

      {!loading && !error && !query && (
        <div className="flex flex-col items-center py-12 text-cafe-muted">
          <HubIcon name="search" className="mb-3 h-8 w-8 opacity-30" />
          <p className="text-sm">搜索关键词，发现能力</p>
          <p className="mt-1 text-xs">支持 Claude · Codex · OpenClaw · Antigravity 四大生态</p>
        </div>
      )}
    </div>
  );
}
