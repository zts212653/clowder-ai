import type { ApprovalFeatureId, ApprovalHubItem } from '@cat-cafe/shared';
import { useState, useSyncExternalStore } from 'react';
import { ApprovalPendingPane, type ApprovalStatusFilter } from '@/components/ApprovalPendingPane';
import { isApprovalItemBatchDecidable } from '@/lib/approval-features';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { ShellGlyph } from '../ShellIcons';
import { useShellCopy } from '../shell-copy';
import type { UnifiedAttentionView } from '../use-unified-attention';
import { matchHostedApproval } from './approval-match';
import { describeReconcile } from './approval-reconcile';
import { type ApprovalSessions, sessionKey } from './approval-sessions';
import { HostedApprovalCard } from './HostedApprovalCard';
import { handledHistoryCopy } from './handled-history.shell-copy';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import type { MailboxSection } from './mailbox-navigation';
import { resolveOriginalPlace } from './original-place';

/** The existing filters/history/batch eligibility, scoped to decisions the current owner read can actually authorize. */
export function MailboxApprovalTools({
  view,
  sessions,
  onBack,
  onOpenPlace,
}: {
  section: 'records' | 'tools';
  view: UnifiedAttentionView;
  sessions: ApprovalSessions;
  onBack: () => void;
  onOpenPlace: (place: ReturnType<typeof resolveOriginalPlace>) => void;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  useSyncExternalStore(sessions.subscribe, sessions.getVersion, sessions.getVersion);
  const [featureFilters, setFeatureFilters] = useState<Set<ApprovalFeatureId>>(() => new Set());
  const [statusFilter, setStatusFilter] = useState<ApprovalStatusFilter>('all');
  const [threadQuery, setThreadQuery] = useState('');
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const rawItems = useApprovalHubStore((state) => state.items);
  const loading = useApprovalHubStore((state) => state.isLoading);
  const available = useApprovalHubStore((state) => state.pendingReadAvailable);
  const read = view.result.kind === 'ok' ? view.result.read : view.staleRead;
  const rows = read ? read.items.filter((row) => row.approval !== undefined) : [];
  const displayedItems = rows.flatMap((row) =>
    row.approval && read ? [{ ...row.approval, ownerUserId: read.identity.ownerUserId }] : [],
  );
  const current =
    view.result.kind === 'ok' &&
    Array.isArray(rawItems) &&
    read !== null &&
    view.resultGeneration === view.readsStarted() &&
    read.sources.approvals.status === 'available';
  const findRow = (item: ApprovalHubItem) =>
    rows.find(
      (row) => row.approval?.proposalId === item.proposalId && row.approval.sourceFeatureId === item.sourceFeatureId,
    );
  const matchesStore = (item: ApprovalHubItem) => {
    const row = findRow(item);
    return (
      read !== null &&
      row?.approval !== undefined &&
      matchHostedApproval({
        read: row.approval,
        readOwnerUserId: read.identity.ownerUserId,
        storeItems: useApprovalHubStore.getState().items,
        now: Date.now(),
      }).kind === 'matched'
    );
  };
  const canBatchDecide = (item: ApprovalHubItem) => {
    const store = useApprovalHubStore.getState();
    const session = read ? sessions.get(sessionKey(read.identity.ownerUserId, item)) : undefined;
    return (
      current &&
      view.resultGeneration === view.readsStarted() &&
      !loading &&
      available &&
      store.pendingReadAvailable &&
      !store.isLoading &&
      session !== undefined &&
      describeReconcile(session.model.state).actions === 'allowed' &&
      isApprovalItemBatchDecidable(item) &&
      matchesStore(item)
    );
  };
  const decideBatch = (kind: 'approve' | 'reject') => {
    const store = useApprovalHubStore.getState();
    if (!store.selectedIds.size) return;
    const refuseBatch = () => setBatchNotice(t.batchChanged);
    if (!current || !read || loading || !available || !store.pendingReadAvailable || store.isLoading) {
      refuseBatch();
      return;
    }
    const candidates = store.items.filter((item) => store.selectedIds.has(item.proposalId));
    // Check the entire live selection, including missing copies and held sessions, before any original writer starts.
    if (candidates.length !== store.selectedIds.size || candidates.some((item) => !canBatchDecide(item))) {
      refuseBatch();
      return;
    }
    const ready = candidates.map((item) => ({ item, key: sessionKey(read.identity.ownerUserId, item) }));
    if (!ready.every(({ key }) => sessions.authorize(key))) {
      refuseBatch();
      return;
    }
    setBatchNotice(null);
    store.clearSelection();
    // Start each original single-item action in this synchronous turn, before any response can invalidate the read.
    const writes = ready.map(({ item }) =>
      kind === 'approve' ? store.approveProposal(item.proposalId) : store.rejectProposal(item.proposalId),
    );
    onBack();
    void Promise.allSettled(writes);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="mailbox-approval-tools">
      <button
        type="button"
        data-testid="mailbox-records-back"
        onClick={onBack}
        className="shell-nav-row shell-focusable mx-3 mb-2 rounded-lg px-2 py-1 text-left text-sm"
      >
        ‹ {t.back}
      </button>
      {!read ? (
        <div className="space-y-2 px-3 text-sm" data-testid="mailbox-tools-unverified">
          <p>{view.result.kind === 'loading' ? t.toolsLoading : t.toolsUnavailable}</p>
          <button type="button" className="shell-nav-row shell-focusable rounded-lg px-2 py-1" onClick={view.refetch}>
            {t.reread}
          </button>
        </div>
      ) : (
        <>
          {!current ? <output className="px-3 text-xs">{t.toolsUnverified}</output> : null}
          {batchNotice ? (
            <output className="px-3 py-2 text-sm" data-testid="mailbox-batch-notice">
              {batchNotice}
            </output>
          ) : null}
          <ApprovalPendingPane
            featureFilters={featureFilters}
            onFeatureFiltersChange={setFeatureFilters}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            threadQuery={threadQuery}
            onThreadQueryChange={setThreadQuery}
            consumer={{
              items: displayedItems,
              canBatchDecide,
              emptyMessage: !current ? t.toolsReadAgain : t.toolsEmptyPage,
              onBatchDecision: decideBatch,
              renderItem: (item) => {
                const row = findRow(item);
                return row && read ? (
                  <section data-testid={`mailbox-tools-item-${item.proposalId}`}>
                    {!matchesStore(item) ? <p className="mb-2 text-sm font-semibold">{item.summary}</p> : null}
                    <HostedApprovalCard
                      item={row}
                      ownerUserId={read.identity.ownerUserId}
                      sessions={sessions}
                      place={resolveOriginalPlace(row)}
                      onOpen={onOpenPlace}
                      readCurrent={current}
                    />
                  </section>
                ) : null;
              },
            }}
          />
        </>
      )}
      {read?.page.hasMore ? <p className="px-3 text-xs">{t.toolsBatchScope}</p> : null}
    </div>
  );
}

export function MailboxSecondLayer({
  onNavigate,
  disabled = false,
}: {
  onNavigate: (section: MailboxSection) => void;
  disabled?: boolean;
}) {
  const t = useShellCopy(handledHistoryCopy);
  return (
    <footer className="flex-none border-t px-[22px] py-3 text-sm" style={{ borderColor: 'var(--shell-hairline)' }}>
      <button
        type="button"
        disabled={disabled}
        data-testid="mailbox-history"
        onClick={() => onNavigate('history')}
        className="shell-nav-row shell-focusable inline-flex w-full items-center gap-2 rounded-lg py-1 text-left disabled:opacity-50"
      >
        <ShellGlyph name="history" className="h-4 w-4" />
        {t.title}
        <span aria-hidden="true">›</span>
      </button>
    </footer>
  );
}
