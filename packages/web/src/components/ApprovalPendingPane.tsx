'use client';

import type { ApprovalFeatureId, ApprovalItem } from '@cat-cafe/shared';
import { useEffect, useMemo } from 'react';
import { countApprovalFeatures, isApprovalItemBatchDecidable } from '@/lib/approval-features';
import { approvalNavigationThreadIds } from '@/lib/approval-navigation';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { ApprovalFeatureFilter } from './ApprovalFeatureFilter';
import { ApprovalItemCard } from './ApprovalItemCard';

export type ApprovalStatusFilter = 'all' | 'pending' | 'stale';

interface ApprovalPendingPaneProps {
  featureFilters: ReadonlySet<ApprovalFeatureId>;
  onFeatureFiltersChange: (features: Set<ApprovalFeatureId>) => void;
  statusFilter: ApprovalStatusFilter;
  onStatusFilterChange: (status: ApprovalStatusFilter) => void;
  threadQuery: string;
  onThreadQueryChange: (query: string) => void;
}

function applyFilters(
  items: ApprovalItem[],
  features: ReadonlySet<ApprovalFeatureId>,
  status: ApprovalStatusFilter,
  threadQuery: string,
): ApprovalItem[] {
  let filtered = items;
  if (features.size > 0) filtered = filtered.filter((item) => features.has(item.sourceFeatureId));
  if (status !== 'all') {
    const now = Date.now();
    filtered = filtered.filter((item) => {
      const stale = item.expiresAt != null && item.expiresAt < now;
      return status === 'stale' ? stale : !stale;
    });
  }
  if (threadQuery.trim()) {
    const query = threadQuery.trim().toLowerCase();
    filtered = filtered.filter((item) =>
      approvalNavigationThreadIds(item.navigation).some((threadId) => threadId.toLowerCase().includes(query)),
    );
  }
  return filtered;
}

export function ApprovalPendingPane({
  featureFilters,
  onFeatureFiltersChange,
  statusFilter,
  onStatusFilterChange,
  threadQuery,
  onThreadQueryChange,
}: ApprovalPendingPaneProps) {
  const items = useApprovalHubStore((state) => state.items);
  const isLoading = useApprovalHubStore((state) => state.isLoading);
  const error = useApprovalHubStore((state) => state.error);
  const selectedIds = useApprovalHubStore((state) => state.selectedIds);
  const selectAllInline = useApprovalHubStore((state) => state.selectAllInline);
  const clearSelection = useApprovalHubStore((state) => state.clearSelection);
  const batchApprove = useApprovalHubStore((state) => state.batchApprove);
  const batchReject = useApprovalHubStore((state) => state.batchReject);
  const batchResults = useApprovalHubStore((state) => state.batchResults);

  useEffect(() => {
    clearSelection();
  }, [clearSelection]);

  const changeFeatureFilters = (features: Set<ApprovalFeatureId>) => {
    clearSelection();
    onFeatureFiltersChange(features);
  };
  const changeStatusFilter = (status: ApprovalStatusFilter) => {
    clearSelection();
    onStatusFilterChange(status);
  };
  const changeThreadQuery = (query: string) => {
    clearSelection();
    onThreadQueryChange(query);
  };

  const filteredItems = useMemo(
    () => applyFilters(items, featureFilters, statusFilter, threadQuery),
    [items, featureFilters, statusFilter, threadQuery],
  );
  const featureCounts = useMemo(() => countApprovalFeatures(items), [items]);
  const filteredIds = useMemo(() => filteredItems.map((item) => item.proposalId), [filteredItems]);
  const inlineCount = filteredItems.filter(isApprovalItemBatchDecidable).length;
  const hasSelection = selectedIds.size > 0;
  const failedResults = batchResults.filter((result) => !result.success);
  const hasActiveFilters = featureFilters.size > 0 || statusFilter !== 'all' || threadQuery.trim() !== '';

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-cafe-subtle/20 px-3 py-1.5"
        data-testid="approval-filter-bar"
      >
        <ApprovalFeatureFilter
          selected={featureFilters}
          counts={featureCounts}
          onChange={changeFeatureFilters}
          testIdPrefix="approval-filter"
        />
        <span className="h-4 w-px bg-cafe-subtle/40" />
        <button
          type="button"
          onClick={() => changeStatusFilter(statusFilter === 'stale' ? 'all' : 'stale')}
          className={`rounded-full px-2 py-0.5 text-micro font-medium transition-all ${
            statusFilter === 'stale'
              ? 'border border-cafe-subtle/60 bg-cafe-surface text-cafe-interactive'
              : 'text-cafe-interactive/40 hover:text-cafe-interactive/60'
          }`}
          data-testid="approval-filter-stale"
        >
          已过期
        </button>
        <input
          type="text"
          value={threadQuery}
          onChange={(event) => changeThreadQuery(event.target.value)}
          placeholder="Thread..."
          className="w-24 rounded border border-cafe-subtle/30 bg-transparent px-2 py-0.5 text-micro text-cafe-interactive placeholder:text-cafe-interactive/30 focus:border-cafe-subtle/60 focus:outline-none"
          data-testid="approval-filter-thread"
        />
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              clearSelection();
              onFeatureFiltersChange(new Set());
              onStatusFilterChange('all');
              onThreadQueryChange('');
            }}
            className="rounded-full px-2 py-0.5 text-micro text-cafe-interactive/40 hover:text-cafe-interactive/60"
            data-testid="approval-filter-clear"
          >
            清除
          </button>
        )}
      </div>

      {inlineCount > 0 && (
        <div
          className="flex items-center gap-2 border-b border-cafe-subtle/20 px-3 py-1.5"
          data-testid="approval-batch-bar"
        >
          <button
            type="button"
            onClick={hasSelection ? clearSelection : () => selectAllInline(filteredIds)}
            className="rounded px-2 py-0.5 text-micro font-medium text-cafe-interactive/60 hover:text-cafe-interactive"
            data-testid="approval-batch-select-toggle"
          >
            {hasSelection ? `取消选择 (${selectedIds.size})` : '全选可操作'}
          </button>
          {hasSelection && (
            <>
              <button
                type="button"
                onClick={() => batchApprove()}
                className="rounded px-2 py-0.5 text-micro font-medium text-[var(--semantic-success)] hover:bg-[var(--semantic-success)]/10"
                data-testid="approval-batch-approve"
              >
                批量通过
              </button>
              <button
                type="button"
                onClick={() => batchReject()}
                className="rounded px-2 py-0.5 text-micro font-medium text-[var(--semantic-critical)] hover:bg-[var(--semantic-critical)]/10"
                data-testid="approval-batch-reject"
              >
                批量拒绝
              </button>
            </>
          )}
        </div>
      )}

      {failedResults.length > 0 && (
        <div
          className="border-b border-[var(--semantic-critical)]/20 bg-[var(--semantic-critical)]/5 px-3 py-1.5 text-sm text-[var(--semantic-critical)]"
          data-testid="approval-batch-results"
        >
          <span>{failedResults.length} 项操作失败</span>
          <ul className="mt-1 space-y-0.5 text-xs">
            {failedResults.map((result) => (
              <li key={result.proposalId} data-testid={`batch-fail-${result.proposalId}`}>
                {result.proposalId}: {result.error ?? '未知错误'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {isLoading && items.length === 0 && <PanelMessage>加载中...</PanelMessage>}
        {error && (
          <div className="rounded-lg border border-[var(--semantic-critical)] p-3">
            <p className="text-sm text-[var(--semantic-critical)]">请求失败: {error}</p>
          </div>
        )}
        {!isLoading && !error && items.length === 0 && (
          <PanelMessage testId="approval-empty-state">没有待审批的项目</PanelMessage>
        )}
        {!isLoading && !error && items.length > 0 && filteredItems.length === 0 && (
          <PanelMessage testId="approval-empty-filtered">没有符合筛选条件的项目</PanelMessage>
        )}
        {filteredItems.map((item) => (
          <ApprovalItemCard key={item.proposalId} item={item} />
        ))}
      </div>
    </>
  );
}

function PanelMessage({ children, testId }: { children: string; testId?: string }) {
  return (
    <div className="flex items-center justify-center py-12 opacity-50" data-testid={testId}>
      <p className="text-sm">{children}</p>
    </div>
  );
}
