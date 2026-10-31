import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import type { ApprovalSessions } from './mailbox/approval-sessions';
import { handledHistoryCopy } from './mailbox/handled-history.shell-copy';
import type { HandledHistoryRead } from './mailbox/handled-history-read';
import { MailboxApprovalTools, MailboxSecondLayer } from './mailbox/MailboxApprovalTools';
import { MailboxHandledHistory } from './mailbox/MailboxHandledHistory';
import { MailboxItemGroups } from './mailbox/MailboxItemGroups';
import { MailboxMentionControls } from './mailbox/MailboxMentionControls';
import { MailboxPagination } from './mailbox/MailboxPagination';
import { MailboxPanelHeader } from './mailbox/MailboxPanelHeader';
import { MailboxPersonalNotice } from './mailbox/MailboxPersonalNotice';
import { MailboxReadNotes } from './mailbox/MailboxReadNotes';
import { MailboxRow } from './mailbox/MailboxRow';
import { mailboxEntryCopy } from './mailbox/mailbox-entry.shell-copy';
import { MailboxFeedback, usePendingFeedback } from './mailbox/mailbox-feedback';
import type { MailboxSection } from './mailbox/mailbox-navigation';
import { type MailboxDisplayRow, useMailboxRows } from './mailbox/mailbox-rows';
import type { OriginalPlace } from './mailbox/original-place';
import { RetainedResult } from './mailbox/RetainedResults';
import { useHandledHistory } from './mailbox/use-handled-history';
import { RAIL_WIDTH_FALLBACK, useEscapeToClose, useOpenRow, useRailEdge } from './mailbox/use-mailbox-panel-layout';
import { useMailboxPersonalPreferences } from './mailbox/use-mailbox-personal-preferences';
import { useShellCopy } from './shell-copy';
import { deriveMailboxState, type MailboxState } from './unified-mailbox-state';
import type { UnifiedAttentionView } from './use-unified-attention';

const PANEL_WIDTH = 440;
/**
 * What the panel shows, and whose it is. While re-reading, the previous rows may stay visible, but only labelled as the
 * previous read — never as current. The owner is the read's verified identity (a previous read is shown only once its owner is
 * confirmed again); with no read to confirm one there is no owner, and so nothing that belongs to an owner is shown.
 */
function panelRows(view: UnifiedAttentionView, sessions: ApprovalSessions) {
  const read = view.result.kind === 'ok' ? view.result.read : null;
  const staleRead = view.result.kind !== 'ok' ? view.staleRead : null;
  const shown = read ?? staleRead;
  const items = shown?.items ?? [];
  const ownerUserId = shown?.identity.ownerUserId ?? null;
  return {
    read,
    staleRead,
    items,
    ownerUserId,
    hosted: ownerUserId !== null ? { sessions, ownerUserId } : undefined,
  };
}

/**
 * 待办 as a full-height panel that slides out beside the rail (Café 1.6). It is non-modal: it stays until it is closed
 * (×, Escape, the rail button again) and the work area behind it keeps working, so a click elsewhere does not dismiss it
 * (the design owner's call). A dialog opened by a card inside it must take Escape first and must never unmount the panel or
 * lose a draft; that is proven where such cards are hosted (S3-2b), not here. Handled requests have their own page; approval records stay in the existing approval consumer.
 */
function MailboxPanelContent({
  anchor,
  state,
  view,
  sessions,
  onOpenPlace,
  onClose,
  section = 'pending',
  onSectionChange,
  selectedProposalId = null,
  onOpenSchedule,
  historyRead,
  projectFeedback,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  state: MailboxState;
  view: UnifiedAttentionView;
  /** Where decisions made on an approval's original card are followed (kept by the rail button, so they outlive this panel). */
  sessions: ApprovalSessions;
  onOpenPlace: (place: OriginalPlace) => void;
  onClose: () => void;
  section?: MailboxSection;
  onSectionChange?: (section: MailboxSection) => void;
  selectedProposalId?: string | null;
  onOpenSchedule?: () => void;
  historyRead?: HandledHistoryRead;
  projectFeedback: (rows: MailboxDisplayRow[]) => MailboxDisplayRow[];
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const historyCopy = useShellCopy(handledHistoryCopy);
  const personal = useMailboxPersonalPreferences(view);
  const panelRef = useRef<HTMLDivElement>(null);
  const left = useRailEdge(anchor);

  const mentionOwner = useRef<string | null>(null);
  const { read, staleRead, items, ownerUserId, hosted } = panelRows(view, sessions);
  if (ownerUserId !== null) mentionOwner.current = ownerUserId;
  else if (view.result.kind === 'failed') mentionOwner.current = null;
  const apiOwner = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  ).ownerUserId;
  const { read: handledRead, snapshot: historySnapshot } = useHandledHistory(
    ownerUserId ?? apiOwner,
    section === 'history' || section === 'records' || section === 'ignored',
    historyRead,
  );
  const oldResults = useRef(
    new Set(
      sessions
        .list()
        .filter((session) => session.model.state.kind === 'decided')
        .map((session) => session.key),
    ),
  );
  const baseRows = useMailboxRows(items, sessions, ownerUserId);
  const allRows = (ownerUserId ? projectFeedback(baseRows) : []).filter(
    (row) => row.kind !== 'retained' || !oldResults.current.has(row.session.key),
  );
  const rows =
    section === 'history' ? allRows.filter((row) => row.kind === 'item' && row.item.kind === 'user_mention') : allRows;
  const keys = rows.map((row) => row.key);
  const { openKey, toggle } = useOpenRow(keys, view.result.kind === 'loading');
  const canRetry =
    state.kind === 'unavailable' || state.kind === 'partial' || (state.kind === 'has-items' && state.partial);
  // The identically named Needs me tab and rail count the same qualified decisions, never @you requests.
  const decisionState = deriveMailboxState(view.badgeResult ?? view.result);
  const total = decisionState.kind === 'empty' ? 0 : decisionState.kind === 'has-items' ? decisionState.count : null;

  // A hidden element can't take focus, so move focus in only once the panel is positioned and visible.
  useEffect(() => {
    if (left === null) return;
    const first =
      panelRef.current?.querySelector<HTMLElement>('[data-testid="mailbox-item-toggle"]:not(:disabled)') ??
      panelRef.current?.querySelector<HTMLElement>('[data-testid="mailbox-close"]');
    (first ?? panelRef.current)?.focus();
  }, [left]);
  useEscapeToClose(panelRef, onClose);
  const handledSelection = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedProposalId) {
      handledSelection.current = null;
      return;
    }
    if (handledSelection.current === selectedProposalId) return;
    const row = rows.find((row) => row.kind === 'item' && row.item.approval?.proposalId === selectedProposalId);
    if (row) {
      handledSelection.current = selectedProposalId;
      if (openKey !== row.key) toggle(row.key);
    }
  }, [selectedProposalId, rows, openKey, toggle]);

  const completeRead = Boolean(
    read &&
      read.status === 'available' &&
      read.consistency.state === 'verified' &&
      read.totalCount !== undefined &&
      Object.values(read.sources).every(
        (source) => source.status === 'available' && source.exhaustiveness === 'complete',
      ),
  );
  const completePage = Boolean(completeRead && read?.page.offset === 0 && !read.page.hasMore);
  const personalRead = read?.personalView;
  const groupCounts = completeRead && personalRead ? personalRead.groupCounts?.[personalRead.mode] : undefined;
  const renderRow = (row: MailboxDisplayRow) =>
    row.kind === 'feedback' ? (
      <li
        key={row.key}
        data-testid="mailbox-transient-result"
        className="truncate rounded-lg px-3 py-2 text-xs text-[var(--shell-muted)]"
      >
        ● {row.result === 'ignored' ? historyCopy.ignoredResult : historyCopy.handledJustNow} ·{' '}
        {row.item.userMention?.threadTitle ?? row.item.summary}
      </li>
    ) : row.kind === 'retained' ? (
      <RetainedResult key={row.key} session={row.session} sessions={sessions} />
    ) : (
      <MailboxRow
        key={row.key}
        item={row.item}
        rowKey={row.key}
        stale={staleRead !== null}
        expanded={openKey === row.key}
        onToggle={() => toggle(row.key)}
        onOpen={onOpenPlace}
        hosted={hosted}
        personal={section === 'pending' || section === 'ignored' ? personal.actions : undefined}
        readCurrent={read !== null && view.resultGeneration === view.readsStarted()}
      />
    );
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t.title}
      tabIndex={-1}
      data-testid="mailbox-panel"
      className="shell-slide-in fixed bottom-0 top-0 z-[90] flex flex-col outline-none"
      style={{
        left: left ?? RAIL_WIDTH_FALLBACK,
        width: `min(${PANEL_WIDTH}px, calc(100vw - ${left ?? RAIL_WIDTH_FALLBACK}px))`,
        visibility: left === null ? 'hidden' : 'visible',
        background: 'var(--shell-work)',
        borderRight: '1px solid var(--shell-hairline-strong)',
        boxShadow: '4px 0 10px rgb(20 20 19 / 0.08)',
        color: 'var(--shell-ink)',
      }}
    >
      <MailboxPanelHeader
        section={section}
        total={total}
        onClose={onClose}
        onBack={() => onSectionChange?.('pending')}
        onOpenSchedule={onOpenSchedule}
      />
      {section === 'history' || section === 'records' || section === 'ignored' ? (
        <>
          <MailboxPersonalNotice personal={personal} />
          <MailboxHandledHistory
            section={section === 'ignored' ? 'ignored' : 'history'}
            view={view}
            personal={personal}
            onSectionChange={onSectionChange}
            snapshot={historySnapshot}
            read={handledRead}
            onOpenPlace={onOpenPlace}
            verifyCurrent={() => view.resultGeneration === view.readsStarted()}
          />
        </>
      ) : section === 'tools' && read !== null ? (
        <MailboxApprovalTools
          section={section}
          view={view}
          sessions={sessions}
          onOpenPlace={onOpenPlace}
          onBack={() => onSectionChange?.('pending')}
        />
      ) : (
        <div
          role="region"
          id="mailbox-tabpanel"
          aria-labelledby="mailbox-tab-needs-me"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[22px] pb-4"
        >
          <MailboxPersonalNotice personal={personal} />
          <MailboxReadNotes state={state} read={read} stale={staleRead !== null} />
          {section === 'pending' && onSectionChange ? (
            <button
              type="button"
              className="shell-focusable mb-2 self-start text-xs hover:underline"
              data-testid="mailbox-tools"
              onClick={() => onSectionChange('tools')}
            >
              {t.approvalTools}
            </button>
          ) : null}
          {section === 'pending' ? (
            <MailboxItemGroups
              section={section}
              rows={rows}
              readKnown={read !== null}
              complete={completePage}
              groupCounts={groupCounts}
              mentionControls={
                section === 'pending' ? (
                  <MailboxMentionControls
                    key={mentionOwner.current}
                    read={read}
                    view={view}
                    personal={personal}
                    count={
                      !read
                        ? t.state.unconfirmed
                        : groupCounts
                          ? String(groupCounts.userMentions)
                          : t.pageItems(
                              rows.filter((row) => row.kind === 'item' && row.item.kind === 'user_mention').length,
                            )
                    }
                  />
                ) : undefined
              }
              renderRow={renderRow}
            />
          ) : rows.length ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">{rows.map(renderRow)}</ul>
          ) : null}
          <MailboxPagination read={read} onNextPage={view.nextPage} onPreviousPage={view.previousPage} />
          {canRetry ? (
            <div className="pt-1.5">
              <button
                type="button"
                onClick={view.refetch}
                data-testid="mailbox-retry"
                className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
              >
                {t.retry}
              </button>
            </div>
          ) : null}
        </div>
      )}
      {onSectionChange && section === 'pending' ? (
        <MailboxSecondLayer disabled={read === null} onNavigate={onSectionChange} />
      ) : null}
    </div>,
    document.body,
  );
}

export function MailboxPanel(props: Omit<Parameters<typeof MailboxPanelContent>[0], 'projectFeedback'>) {
  const read = props.view.result.kind === 'ok' ? props.view.result.read : props.view.staleRead;
  const identity = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const feedback = usePendingFeedback(read?.items ?? [], identity.ownerUserId ?? read?.identity.ownerUserId ?? null);
  return (
    <MailboxFeedback.Provider value={feedback.acknowledge}>
      <MailboxPanelContent {...props} projectFeedback={feedback.project} />
    </MailboxFeedback.Provider>
  );
}
