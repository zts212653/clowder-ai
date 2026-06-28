'use client';

/**
 * F246 Phase C+D: Approval Panel for workspace mode.
 *
 * Replaces the ApprovalHubDrawer — same data and actions, but rendered
 * inline in the workspace panel instead of as a fixed overlay. Enjoys
 * full panel width and participates in workspace tab routing.
 *
 * Phase D additions: AC-D4 filter bar (by feature / thread / stale).
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { ApprovalItemCard } from './ApprovalItemCard';

type FeatureFilter = 'all' | 'F128' | 'F225' | 'F193' | 'F231';
type StatusFilter = 'all' | 'pending' | 'stale';

/** Feature display names for filter chips. */
const FEATURE_LABELS: Record<FeatureFilter, string> = {
  all: '全部',
  F128: '线程',
  F225: '会话',
  F193: '派发',
  F231: '画像',
};

function applyFilters(
  items: ApprovalItem[],
  feature: FeatureFilter,
  status: StatusFilter,
  threadQuery: string,
): ApprovalItem[] {
  let filtered = items;
  if (feature !== 'all') {
    filtered = filtered.filter((i) => i.sourceFeatureId === feature);
  }
  if (status !== 'all') {
    const now = Date.now();
    filtered = filtered.filter((i) => {
      const isStale = i.expiresAt != null && i.expiresAt < now;
      return status === 'stale' ? isStale : !isStale;
    });
  }
  if (threadQuery.trim()) {
    const q = threadQuery.trim().toLowerCase();
    filtered = filtered.filter((i) => i.sourceThreadId.toLowerCase().includes(q));
  }
  return filtered;
}

export function ApprovalPanel() {
  const items = useApprovalHubStore((s) => s.items);
  const count = useApprovalHubStore((s) => s.count);
  const isLoading = useApprovalHubStore((s) => s.isLoading);
  const error = useApprovalHubStore((s) => s.error);
  const fetchPending = useApprovalHubStore((s) => s.fetchPending);

  // AC-D5: batch selection and actions
  const selectedIds = useApprovalHubStore((s) => s.selectedIds);
  const selectAllInline = useApprovalHubStore((s) => s.selectAllInline);
  const clearSelection = useApprovalHubStore((s) => s.clearSelection);
  const batchApprove = useApprovalHubStore((s) => s.batchApprove);
  const batchReject = useApprovalHubStore((s) => s.batchReject);
  const batchResults = useApprovalHubStore((s) => s.batchResults);

  // AC-D4: filter state (UI-only, not persisted)
  const [featureFilter, setFeatureFilter] = useState<FeatureFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [threadQuery, setThreadQuery] = useState('');

  // Clear batch selection when filters change — prevents stale invisible selections
  // from being batch-approved (P1 review finding: scope-mismatch across filter transitions)
  useEffect(() => {
    clearSelection();
  }, [featureFilter, statusFilter, threadQuery, clearSelection]);

  const filteredItems = useMemo(
    () => applyFilters(items, featureFilter, statusFilter, threadQuery),
    [items, featureFilter, statusFilter, threadQuery],
  );

  const hasActiveFilters = featureFilter !== 'all' || statusFilter !== 'all' || threadQuery.trim() !== '';
  const inlineCount = filteredItems.filter((i) => i.inlineApprovable).length;
  const hasSelection = selectedIds.size > 0;
  const filteredIds = useMemo(() => filteredItems.map((i) => i.proposalId), [filteredItems]);
  const batchFailedCount = batchResults.filter((r) => !r.success).length;

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="approval-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-cafe-subtle/40">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">待审批</h3>
          {count > 0 && (
            <span
              className="min-w-[20px] h-5 px-1.5 rounded-full text-micro font-bold flex items-center justify-center"
              style={{ backgroundColor: 'var(--semantic-warning)', color: 'var(--cafe-accent-foreground)' }}
            >
              {count > 99 ? '99+' : String(count)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => fetchPending()}
          className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-[var(--cafe-muted)]"
          title="刷新"
          data-testid="approval-panel-refresh"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
            <title>刷新</title>
            <path
              d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m0 0a9 9 0 0 1 9-9m-9 9a9 9 0 0 0 9 9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* AC-D4: Filter bar */}
      <div
        className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-cafe-subtle/20"
        data-testid="approval-filter-bar"
      >
        {/* Feature chips */}
        {(Object.keys(FEATURE_LABELS) as FeatureFilter[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFeatureFilter(key)}
            className={`px-2 py-0.5 rounded-full text-micro font-medium transition-all ${
              featureFilter === key
                ? 'bg-cafe-surface text-cafe-interactive border border-cafe-subtle/60'
                : 'text-cafe-interactive/40 hover:text-cafe-interactive/60'
            }`}
            data-testid={`approval-filter-feature-${key}`}
          >
            {FEATURE_LABELS[key]}
          </button>
        ))}

        {/* Separator */}
        <span className="w-px h-4 bg-cafe-subtle/40" />

        {/* Status filter */}
        <button
          type="button"
          onClick={() => setStatusFilter(statusFilter === 'stale' ? 'all' : 'stale')}
          className={`px-2 py-0.5 rounded-full text-micro font-medium transition-all ${
            statusFilter === 'stale'
              ? 'bg-cafe-surface text-cafe-interactive border border-cafe-subtle/60'
              : 'text-cafe-interactive/40 hover:text-cafe-interactive/60'
          }`}
          data-testid="approval-filter-stale"
        >
          已过期
        </button>

        {/* Thread search */}
        <input
          type="text"
          value={threadQuery}
          onChange={(e) => setThreadQuery(e.target.value)}
          placeholder="Thread..."
          className="w-24 px-2 py-0.5 rounded text-micro bg-transparent border border-cafe-subtle/30 text-cafe-interactive placeholder:text-cafe-interactive/30 focus:border-cafe-subtle/60 focus:outline-none"
          data-testid="approval-filter-thread"
        />

        {/* Clear all filters */}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              setFeatureFilter('all');
              setStatusFilter('all');
              setThreadQuery('');
            }}
            className="px-2 py-0.5 rounded-full text-micro text-cafe-interactive/40 hover:text-cafe-interactive/60"
            data-testid="approval-filter-clear"
          >
            清除
          </button>
        )}
      </div>

      {/* AC-D5: Batch action bar */}
      {inlineCount > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 border-b border-cafe-subtle/20"
          data-testid="approval-batch-bar"
        >
          <button
            type="button"
            onClick={hasSelection ? clearSelection : () => selectAllInline(filteredIds)}
            className="px-2 py-0.5 rounded text-micro font-medium text-cafe-interactive/60 hover:text-cafe-interactive"
            data-testid="approval-batch-select-toggle"
          >
            {hasSelection ? `取消选择 (${selectedIds.size})` : '全选可操作'}
          </button>
          {hasSelection && (
            <>
              <button
                type="button"
                onClick={() => batchApprove()}
                className="px-2 py-0.5 rounded text-micro font-medium text-[var(--semantic-success)] hover:bg-[var(--semantic-success)]/10"
                data-testid="approval-batch-approve"
              >
                批量通过
              </button>
              <button
                type="button"
                onClick={() => batchReject()}
                className="px-2 py-0.5 rounded text-micro font-medium text-[var(--semantic-critical)] hover:bg-[var(--semantic-critical)]/10"
                data-testid="approval-batch-reject"
              >
                批量拒绝
              </button>
            </>
          )}
        </div>
      )}

      {/* AC-D5: Batch results feedback — per-item partial failure visibility */}
      {batchFailedCount > 0 && (
        <div
          className="px-3 py-1.5 border-b border-[var(--semantic-critical)]/20 bg-[var(--semantic-critical)]/5 text-sm text-[var(--semantic-critical)]"
          data-testid="approval-batch-results"
        >
          <span>{batchFailedCount} 项操作失败</span>
          <ul className="mt-1 text-xs space-y-0.5">
            {batchResults
              .filter((r) => !r.success)
              .map((r) => (
                <li key={r.proposalId} data-testid={`batch-fail-${r.proposalId}`}>
                  {r.proposalId}: {r.error ?? '未知错误'}
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {isLoading && items.length === 0 && (
          <div className="flex items-center justify-center py-8 opacity-50">
            <p className="text-sm">加载中...</p>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-[var(--semantic-critical)] p-3">
            <p className="text-sm text-[var(--semantic-critical)]">加载失败: {error}</p>
          </div>
        )}

        {!isLoading && !error && items.length === 0 && (
          <div
            className="flex flex-col items-center justify-center py-12 opacity-50"
            data-testid="approval-empty-state"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8 mb-2">
              <title>无待审批</title>
              <path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p className="text-sm">没有待审批的项目</p>
          </div>
        )}

        {!isLoading && !error && items.length > 0 && filteredItems.length === 0 && (
          <div
            className="flex flex-col items-center justify-center py-12 opacity-50"
            data-testid="approval-empty-filtered"
          >
            <p className="text-sm">没有符合筛选条件的项目</p>
          </div>
        )}

        {filteredItems.map((item) => (
          <ApprovalItemCard key={item.proposalId} item={item} />
        ))}
      </div>
    </div>
  );
}
