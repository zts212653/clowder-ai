'use client';

/** F246 Approval Hub workspace panel: navigation shell + persistent filter state. */

import type { ApprovalFeatureId } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { type ApprovalHistoryOutcomeFilter, ApprovalHistoryPane } from './ApprovalHistoryPane';
import { ApprovalPendingPane, type ApprovalStatusFilter } from './ApprovalPendingPane';

type ActiveTab = 'pending' | 'history';

export function ApprovalPanel() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('pending');
  const [featureFilters, setFeatureFilters] = useState<Set<ApprovalFeatureId>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<ApprovalStatusFilter>('all');
  const [threadQuery, setThreadQuery] = useState('');
  const [historyFeatureFilters, setHistoryFeatureFilters] = useState<Set<ApprovalFeatureId>>(() => new Set());
  const [historyOutcomeFilter, setHistoryOutcomeFilter] = useState<ApprovalHistoryOutcomeFilter>('all');

  const count = useApprovalHubStore((state) => state.count);
  const fetchPending = useApprovalHubStore((state) => state.fetchPending);
  const fetchSettled = useApprovalHubStore((state) => state.fetchSettled);

  useEffect(() => {
    if (activeTab === 'history') fetchSettled?.();
  }, [activeTab, fetchSettled]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="approval-panel">
      <div className="flex items-center justify-between border-b border-cafe-subtle/40 px-3 py-2">
        <div className="flex items-center gap-0.5" data-testid="approval-tab-bar">
          <TabButton active={activeTab === 'pending'} onClick={() => setActiveTab('pending')} testId="pending">
            待审批
            {count > 0 && (
              <span
                className="flex h-5 min-w-[18px] items-center justify-center rounded-full px-1 text-micro font-bold"
                style={{ backgroundColor: 'var(--semantic-warning)', color: 'var(--cafe-accent-foreground)' }}
              >
                {count > 99 ? '99+' : String(count)}
              </span>
            )}
          </TabButton>
          <TabButton active={activeTab === 'history'} onClick={() => setActiveTab('history')} testId="history">
            历史
          </TabButton>
        </div>

        <button
          type="button"
          onClick={() => (activeTab === 'pending' ? fetchPending?.() : fetchSettled?.())}
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--cafe-muted)]"
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

      {activeTab === 'pending' ? (
        <ApprovalPendingPane
          featureFilters={featureFilters}
          onFeatureFiltersChange={setFeatureFilters}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          threadQuery={threadQuery}
          onThreadQueryChange={setThreadQuery}
        />
      ) : (
        <ApprovalHistoryPane
          featureFilters={historyFeatureFilters}
          onFeatureFiltersChange={setHistoryFeatureFilters}
          outcomeFilter={historyOutcomeFilter}
          onOutcomeFilterChange={setHistoryOutcomeFilter}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: ActiveTab;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-all ${
        active ? 'bg-cafe-surface text-cafe-interactive' : 'text-cafe-interactive/50 hover:text-cafe-interactive/70'
      }`}
      data-testid={`approval-tab-${testId}`}
    >
      {children}
    </button>
  );
}
