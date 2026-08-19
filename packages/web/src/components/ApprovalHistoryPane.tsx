'use client';

import type { ApprovalFeatureId } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { countApprovalFeatures } from '@/lib/approval-features';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { ApprovalFeatureFilter } from './ApprovalFeatureFilter';
import { ApprovalHistoryList } from './ApprovalHistoryList';

export type ApprovalHistoryOutcomeFilter = 'all' | 'approved' | 'rejected';

interface ApprovalHistoryPaneProps {
  featureFilters: ReadonlySet<ApprovalFeatureId>;
  onFeatureFiltersChange: (features: Set<ApprovalFeatureId>) => void;
  outcomeFilter: ApprovalHistoryOutcomeFilter;
  onOutcomeFilterChange: (outcome: ApprovalHistoryOutcomeFilter) => void;
}

export function ApprovalHistoryPane({
  featureFilters,
  onFeatureFiltersChange,
  outcomeFilter,
  onOutcomeFilterChange,
}: ApprovalHistoryPaneProps) {
  const settledItems = useApprovalHubStore((state) => state.settledItems);
  const isLoading = useApprovalHubStore((state) => state.settledIsLoading);
  const error = useApprovalHubStore((state) => state.settledError);
  const featureCounts = useMemo(() => countApprovalFeatures(settledItems), [settledItems]);
  const filteredItems = useMemo(() => {
    let filtered = settledItems;
    if (featureFilters.size > 0) {
      filtered = filtered.filter((item) => featureFilters.has(item.sourceFeatureId));
    }
    if (outcomeFilter !== 'all') filtered = filtered.filter((item) => item.status === outcomeFilter);
    return filtered;
  }, [settledItems, featureFilters, outcomeFilter]);
  const hasActiveFilters = featureFilters.size > 0 || outcomeFilter !== 'all';

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-cafe-subtle/20 px-3 py-1.5"
        data-testid="approval-history-filter-bar"
      >
        <ApprovalFeatureFilter
          selected={featureFilters}
          counts={featureCounts}
          onChange={onFeatureFiltersChange}
          testIdPrefix="approval-history-filter"
        />
        <span className="h-4 w-px bg-cafe-subtle/40" />
        <OutcomeButton
          active={outcomeFilter === 'approved'}
          onClick={() => onOutcomeFilterChange(outcomeFilter === 'approved' ? 'all' : 'approved')}
          status="approved"
        />
        <OutcomeButton
          active={outcomeFilter === 'rejected'}
          onClick={() => onOutcomeFilterChange(outcomeFilter === 'rejected' ? 'all' : 'rejected')}
          status="rejected"
        />
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              onFeatureFiltersChange(new Set());
              onOutcomeFilterChange('all');
            }}
            className="rounded-full px-2 py-0.5 text-micro text-cafe-interactive/40 hover:text-cafe-interactive/60"
            data-testid="approval-history-filter-clear"
          >
            清除
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto" data-testid="approval-history-content">
        {isLoading && settledItems.length === 0 && <HistoryMessage>加载中...</HistoryMessage>}
        {error && (
          <div className="m-3 rounded-lg border border-[var(--semantic-critical)] p-3">
            <p className="text-sm text-[var(--semantic-critical)]">加载失败: {error}</p>
          </div>
        )}
        {!isLoading && !error && settledItems.length === 0 && (
          <HistoryMessage testId="approval-history-empty">还没有审批记录</HistoryMessage>
        )}
        {!isLoading && !error && settledItems.length > 0 && filteredItems.length === 0 && (
          <HistoryMessage>没有符合筛选条件的记录</HistoryMessage>
        )}
        {!isLoading && !error && filteredItems.length > 0 && <ApprovalHistoryList items={filteredItems} />}
      </div>
    </>
  );
}

function OutcomeButton({
  active,
  onClick,
  status,
}: {
  active: boolean;
  onClick: () => void;
  status: 'approved' | 'rejected';
}) {
  const approved = status === 'approved';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-micro font-medium transition-all ${
        active
          ? `border border-cafe-subtle/60 bg-cafe-surface ${approved ? 'text-[var(--semantic-success)]' : 'text-[var(--semantic-critical)]'}`
          : 'text-cafe-interactive/40 hover:text-cafe-interactive/60'
      }`}
      data-testid={`approval-history-filter-${status}`}
    >
      {approved ? '✅ 通过' : '❌ 拒绝'}
    </button>
  );
}

function HistoryMessage({ children, testId }: { children: string; testId?: string }) {
  return (
    <div className="flex items-center justify-center py-12 opacity-50" data-testid={testId}>
      <p className="text-sm">{children}</p>
    </div>
  );
}
