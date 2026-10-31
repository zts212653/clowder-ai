'use client';

import type { ApprovalFeatureId, ApprovalHubItem } from '@cat-cafe/shared';
import { Fragment, type ReactNode, useEffect, useMemo, useRef } from 'react';
import { countApprovalFeatures, isApprovalItemBatchDecidable } from '@/lib/approval-features';
import { approvalNavigationThreadIds } from '@/lib/approval-navigation';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { ApprovalFeatureFilter } from './ApprovalFeatureFilter';
import { ApprovalItemCard } from './ApprovalItemCard';

import { approvalHistoryCopy } from './approval-history.shell-copy';
import { useShellCopy } from './shell/shell-copy';

export type ApprovalStatusFilter = 'all' | 'pending' | 'stale';

/** A host can scope the original list and guard its actions without copying filters or batch eligibility. */
export interface ApprovalPendingConsumer {
  /** The owner's displayed census; eligibility must never remove an existing decision. */
  items: readonly ApprovalHubItem[];
  canBatchDecide(item: ApprovalHubItem): boolean;
  emptyMessage: string;
  renderItem(item: ApprovalHubItem): ReactNode;
  onBatchDecision(kind: 'approve' | 'reject'): void;
}

interface ApprovalPendingPaneProps {
  consumer?: ApprovalPendingConsumer;
  selectedProposalId?: string | null;
  featureFilters: ReadonlySet<ApprovalFeatureId>;
  onFeatureFiltersChange: (features: Set<ApprovalFeatureId>) => void;
  statusFilter: ApprovalStatusFilter;
  onStatusFilterChange: (status: ApprovalStatusFilter) => void;
  threadQuery: string;
  onThreadQueryChange: (query: string) => void;
}

function applyFilters(
  items: ApprovalHubItem[],
  features: ReadonlySet<ApprovalFeatureId>,
  status: ApprovalStatusFilter,
  threadQuery: string,
): ApprovalHubItem[] {
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
  consumer,
  selectedProposalId = null,
  featureFilters,
  onFeatureFiltersChange,
  statusFilter,
  onStatusFilterChange,
  threadQuery,
  onThreadQueryChange,
}: ApprovalPendingPaneProps) {
  const t = useShellCopy(approvalHistoryCopy);
  const rawItems = useApprovalHubStore((state) => state.items);
  const items = useMemo(
    () =>
      consumer
        ? consumer.items.filter(
            (item, index, filtered) =>
              filtered.findIndex(
                (other) => other.proposalId === item.proposalId && other.sourceFeatureId === item.sourceFeatureId,
              ) === index,
          )
        : rawItems,
    [rawItems, consumer],
  );
  const isLoading = useApprovalHubStore((state) => state.isLoading);
  const error = useApprovalHubStore((state) => state.error);
  const fetchPending = useApprovalHubStore((state) => state.fetchPending);
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
  const selectedProposalIsVisible = selectedProposalId
    ? filteredItems.some((item) => item.proposalId === selectedProposalId)
    : false;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedProposalId || !selectedProposalIsVisible) return;
    const target = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-testid]') ?? []).find(
      (candidate) => candidate.dataset.testid === `approval-item-${selectedProposalId}`,
    );
    if (!target) return;
    target.scrollIntoView?.({ block: 'center' });
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, [selectedProposalId, selectedProposalIsVisible]);
  const featureCounts = useMemo(() => countApprovalFeatures(items), [items]);
  const batchItems = filteredItems.filter((item) =>
    consumer ? consumer.canBatchDecide(item) : isApprovalItemBatchDecidable(item),
  );
  const filteredIds = batchItems.map((item) => item.proposalId);
  const inlineCount = batchItems.length;
  const selectedCount = consumer ? filteredIds.filter((id) => selectedIds.has(id)).length : selectedIds.size;
  const hasSelection = selectedCount > 0;
  useEffect(() => {
    if (!consumer || !selectedIds.size) return;
    const remaining = filteredIds.filter((id) => selectedIds.has(id));
    // Only narrow the original transient selection; the display census and classic selection stay unchanged.
    if (remaining.length !== selectedIds.size) selectAllInline(remaining);
  }, [consumer, filteredIds, selectedIds, selectAllInline]);
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
          {t.stale}
        </button>
        <input
          type="text"
          value={threadQuery}
          onChange={(event) => changeThreadQuery(event.target.value)}
          placeholder={t.thread}
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
            {t.clear}
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
            {hasSelection ? t.unselect(selectedCount) : t.selectAll}
          </button>
          {hasSelection && (
            <>
              <button
                type="button"
                onClick={() => (consumer ? consumer.onBatchDecision('approve') : batchApprove())}
                className="rounded px-2 py-0.5 text-micro font-medium text-[var(--semantic-success)] hover:bg-[var(--semantic-success)]/10"
                data-testid="approval-batch-approve"
              >
                {consumer ? t.agreeBatch : t.approveBatch}
              </button>
              <button
                type="button"
                onClick={() => (consumer ? consumer.onBatchDecision('reject') : batchReject())}
                className="rounded px-2 py-0.5 text-micro font-medium text-[var(--semantic-critical)] hover:bg-[var(--semantic-critical)]/10"
                data-testid="approval-batch-reject"
              >
                {t.rejectBatch}
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
          <span>{t.failedCount(failedResults.length)}</span>
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer">{t.failureDetails}</summary>
            <ul className="mt-1 space-y-0.5">
              {failedResults.map((result) => (
                <li key={result.proposalId} data-testid={`batch-fail-${result.proposalId}`} className="break-all">
                  {result.proposalId}: {result.error ?? t.unknownError}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {isLoading && items.length === 0 && <PanelMessage>{t.loading}</PanelMessage>}
        {error && (
          <div className="rounded-lg border border-[var(--semantic-critical)] p-3" data-testid="approval-pending-error">
            <p className="text-sm text-[var(--semantic-critical)]">
              {items.length > 0 ? t.cached : t.pendingUnreadable}
            </p>
            <button type="button" className="mt-2 text-xs underline" onClick={() => void fetchPending()}>
              {t.retry}
            </button>
            <details className="mt-2 text-xs text-cafe-muted">
              <summary className="cursor-pointer">{t.errorDetails}</summary>
              <p className="mt-1 break-words">{error}</p>
            </details>
          </div>
        )}
        {!isLoading && !error && items.length === 0 && (
          <PanelMessage testId="approval-empty-state">{consumer ? consumer.emptyMessage : t.pendingEmpty}</PanelMessage>
        )}
        {!isLoading && !error && items.length > 0 && filteredItems.length === 0 && (
          <PanelMessage testId="approval-empty-filtered">{t.pendingFilteredEmpty}</PanelMessage>
        )}
        {filteredItems.map((item) =>
          consumer ? (
            <Fragment key={`${item.sourceFeatureId}:${item.proposalId}`}>{consumer.renderItem(item)}</Fragment>
          ) : (
            <ApprovalItemCard key={item.proposalId} item={item} />
          ),
        )}
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
