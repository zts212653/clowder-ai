'use client';

import type { ApprovalFeatureId } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { countApprovalFeatures } from '@/lib/approval-features';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { ApprovalFeatureFilter } from './ApprovalFeatureFilter';
import { ApprovalHistoryList } from './ApprovalHistoryList';

import { approvalHistoryCopy } from './approval-history.shell-copy';
import { useShellCopy } from './shell/shell-copy';

export type ApprovalHistoryOutcomeFilter = 'all' | 'accepted' | 'rejected' | 'closed_without_decision';

interface ApprovalHistoryPaneProps {
  ownerUserId?: string;
  featureFilters: ReadonlySet<ApprovalFeatureId>;
  onFeatureFiltersChange: (features: Set<ApprovalFeatureId>) => void;
  outcomeFilter: ApprovalHistoryOutcomeFilter;
  onOutcomeFilterChange: (outcome: ApprovalHistoryOutcomeFilter) => void;
}

export function ApprovalHistoryPane({
  ownerUserId,
  featureFilters,
  onFeatureFiltersChange,
  outcomeFilter,
  onOutcomeFilterChange,
}: ApprovalHistoryPaneProps) {
  const t = useShellCopy(approvalHistoryCopy);
  const rawSettledItems = useApprovalHubStore((state) => state.settledItems);
  const settledItems = useMemo(
    () =>
      ownerUserId === undefined ? rawSettledItems : rawSettledItems.filter((item) => item.ownerUserId === ownerUserId),
    [rawSettledItems, ownerUserId],
  );
  const isLoading = useApprovalHubStore((state) => state.settledIsLoading);
  const error = useApprovalHubStore((state) => state.settledError);
  const fetchSettled = useApprovalHubStore((state) => state.fetchSettled);
  const featureCounts = useMemo(() => countApprovalFeatures(settledItems), [settledItems]);
  const filteredItems = useMemo(() => {
    let filtered = settledItems;
    if (featureFilters.size > 0) {
      filtered = filtered.filter((item) => featureFilters.has(item.sourceFeatureId));
    }
    if (outcomeFilter !== 'all') filtered = filtered.filter((item) => item.resolution === outcomeFilter);
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
          active={outcomeFilter === 'accepted'}
          onClick={() => onOutcomeFilterChange(outcomeFilter === 'accepted' ? 'all' : 'accepted')}
          status="accepted"
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
            {t.clear}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto" data-testid="approval-history-content">
        {isLoading && settledItems.length === 0 && <HistoryMessage>{t.loading}</HistoryMessage>}
        {error && (
          <div
            className="m-3 rounded-lg border border-[var(--semantic-critical)] p-3"
            data-testid="approval-history-error"
          >
            <p className="text-sm text-[var(--semantic-critical)]">
              {settledItems.length > 0 ? t.cached : t.unreadable}
            </p>
            <button type="button" className="mt-2 text-xs underline" onClick={() => void fetchSettled()}>
              {t.retry}
            </button>
            <details className="mt-2 text-xs text-cafe-muted">
              <summary className="cursor-pointer">{t.errorDetails}</summary>
              <p className="mt-1 break-words">{error}</p>
            </details>
          </div>
        )}
        {!isLoading && !error && settledItems.length === 0 && (
          <HistoryMessage testId="approval-history-empty">{t.empty}</HistoryMessage>
        )}
        {!isLoading && !error && settledItems.length > 0 && filteredItems.length === 0 && (
          <HistoryMessage>{t.filteredEmpty}</HistoryMessage>
        )}
        {!isLoading && filteredItems.length > 0 && <ApprovalHistoryList items={filteredItems} />}
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
  status: 'accepted' | 'rejected';
}) {
  const t = useShellCopy(approvalHistoryCopy);
  const accepted = status === 'accepted';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2 py-0.5 text-micro font-medium transition-all ${
        active
          ? `border border-cafe-subtle/60 bg-cafe-surface ${accepted ? 'text-[var(--semantic-success)]' : 'text-[var(--semantic-critical)]'}`
          : 'text-cafe-interactive/40 hover:text-cafe-interactive/60'
      }`}
      data-testid={`approval-history-filter-${status}`}
    >
      {accepted ? t.accepted : t.rejected}
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
