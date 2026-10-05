import type { UnifiedAttentionItemV1, UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type ApprovalSessions, sessionKey } from './mailbox/approval-sessions';
import { MailboxRow } from './mailbox/MailboxRow';
import type { OriginalPlace } from './mailbox/original-place';
import { RetainedResults } from './mailbox/RetainedResults';
import {
  MAILBOX_NAME,
  type MailboxState,
  mailboxPartialNote,
  mailboxStateText,
  sourceStatusText,
} from './unified-mailbox-state';
import type { UnifiedAttentionView } from './use-unified-attention';

const RAIL_WIDTH_FALLBACK = 52;
const PANEL_WIDTH = 440;
const MUTED = { color: 'var(--shell-muted)' } as const;

/** Rows keep every variant the read returned; a repeated decision gets its own key instead of replacing the earlier one. */
function rowKeys(items: readonly UnifiedAttentionItemV1[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = `${item.decisionRef}|${item.approval?.proposalId ?? ''}`;
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    return nth === 0 ? base : `${base}#${nth}`;
  });
}

function SourceNotes({ read }: { read: UnifiedAttentionReadV1 }) {
  const notes = [
    { id: 'approvals', label: '审批', text: sourceStatusText(read.sources.approvals) },
    { id: 'needs-me', label: '等你判断或修复', text: sourceStatusText(read.sources.needsMe) },
  ].filter((note) => note.text !== null);
  if (notes.length === 0) return null;
  return (
    <ul className="m-0 mb-1 list-none px-1 p-0 text-xs" style={MUTED}>
      {notes.map((note) => (
        <li key={note.id} data-testid={`mailbox-source-note-${note.id}`}>
          {note.label}：{note.text}
        </li>
      ))}
    </ul>
  );
}

/** What the read says about itself above the rows: its state, which side is missing, and that rows may be the previous read. */
function ReadNotes({
  state,
  read,
  stale,
}: {
  state: MailboxState;
  read: UnifiedAttentionReadV1 | null;
  stale: boolean;
}) {
  const partialNote = read && state.kind === 'partial' ? mailboxPartialNote(read) : null;
  return (
    <>
      <div className="pb-1.5 text-xs" style={MUTED} data-testid="mailbox-state-text">
        {mailboxStateText(state)}
      </div>
      {read ? <SourceNotes read={read} /> : null}
      {partialNote ? (
        <p className="m-0 pb-1 text-xs" style={MUTED} data-testid="mailbox-partial-note">
          {partialNote}
        </p>
      ) : null}
      {stale ? (
        <p className="m-0 pb-1 text-xs" style={MUTED} data-testid="mailbox-stale-note">
          上次读到的内容，正在更新
        </p>
      ) : null}
      {state.kind === 'empty' ? (
        <p className="m-0 py-2 text-sm" data-testid="mailbox-empty">
          暂无待办
        </p>
      ) : null}
    </>
  );
}

function PanelHeader({ total, onClose }: { total: number | null; onClose: () => void }) {
  return (
    <>
      <div className="flex items-center justify-between pb-2 pl-[22px] pr-3 pt-3">
        <h2 className="m-0 text-base font-semibold" data-testid="mailbox-title">
          {MAILBOX_NAME}
        </h2>
        <button
          type="button"
          data-testid="mailbox-close"
          aria-label={`关闭${MAILBOX_NAME}`}
          onClick={onClose}
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-base leading-none"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div
        role="tablist"
        aria-label={MAILBOX_NAME}
        className="mx-[22px] mb-3 flex gap-0.5 rounded-[10px] p-[3px]"
        style={{ background: 'var(--shell-frame)', boxShadow: 'inset 0 0 0 1px var(--shell-hairline)' }}
      >
        <button
          type="button"
          role="tab"
          id="mailbox-tab-needs-me"
          aria-selected="true"
          aria-controls="mailbox-tabpanel"
          data-testid="mailbox-tab-needs-me"
          className="shell-focusable flex h-[30px] flex-1 items-center justify-center gap-1.5 rounded-lg text-compact font-medium"
          style={{
            background: 'var(--shell-paper)',
            color: 'var(--shell-ink)',
            boxShadow: '0 0 0 1px var(--shell-hairline)',
          }}
        >
          需要我处理
          {total !== null ? (
            <span
              className="rounded-full px-[7px] text-label font-semibold"
              data-testid="mailbox-tab-count"
              style={{ background: 'var(--shell-primary-soft)', color: 'var(--shell-primary-text)' }}
            >
              {total}
            </span>
          ) : null}
        </button>
      </div>
    </>
  );
}

/** The panel docks against the rail's right edge; without a rail in the tree (a bare unit render) it uses the rail's width. */
function useRailEdge(anchor: React.RefObject<HTMLElement | null>): number | null {
  const [edge, setEdge] = useState<number | null>(null);
  useEffect(() => {
    const rail = anchor.current?.closest('[data-testid="world-rail"]');
    setEdge(Math.round(rail?.getBoundingClientRect().right || RAIL_WIDTH_FALLBACK));
  }, [anchor]);
  return edge;
}

/** A nested dialog (for example a card's reject-feedback dialog) owns Escape while it is open. */
function useEscapeToClose(panel: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const otherDialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some(
        (dialog) => dialog !== panel.current,
      );
      if (!otherDialog) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [panel, onClose]);
}

/** Which row is open. A row that left the read is forgotten, not merely hidden: if a later read brings it back it starts closed. */
function useOpenRow(keys: string[]) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const keysSignature = keys.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keysSignature stands for keys
  useEffect(() => {
    setExpandedKey((current) => (current !== null && !keys.includes(current) ? null : current));
  }, [keysSignature]);
  const openKey = expandedKey !== null && keys.includes(expandedKey) ? expandedKey : null;
  return { openKey, toggle: (key: string) => setExpandedKey(openKey === key ? null : key) };
}

/**
 * What the panel shows, and whose it is. While re-reading, the previous rows may stay visible, but only labelled as the
 * previous read — never as current. The owner is the read's verified identity (a previous read is shown only once its owner is
 * confirmed again); with no read to confirm one there is no owner, and so nothing that belongs to an owner is shown.
 */
function panelRows(view: UnifiedAttentionView, sessions: ApprovalSessions) {
  const read = view.result.kind === 'ok' ? view.result.read : null;
  const staleRead = view.result.kind === 'loading' ? view.staleRead : null;
  const shown = read ?? staleRead;
  const items = shown?.items ?? [];
  const ownerUserId = shown?.identity.ownerUserId ?? null;
  const listed = ownerUserId === null ? [] : items.flatMap((item) => (item.approval ? [item.approval] : []));
  return {
    read,
    staleRead,
    items,
    keys: rowKeys(items),
    ownerUserId,
    hosted: ownerUserId !== null ? { sessions, ownerUserId } : undefined,
    listedKeys: new Set(listed.map((approval) => sessionKey(ownerUserId as string, approval))),
  };
}

/**
 * 待办 as a full-height panel that slides out beside the rail (Café 1.6). It is non-modal: it stays until it is closed
 * (×, Escape, the rail button again) and the work area behind it keeps working, so a click elsewhere does not dismiss it
 * (the design owner's call). A dialog opened by a card inside it must take Escape first and must never unmount the panel or
 * lose a draft; that is proven where such cards are hosted (S3-2b), not here. The tab list has one tab for now; 全部工作
 * joins it when it has something to show.
 */
export function MailboxPanel({
  anchor,
  state,
  view,
  sessions,
  onOpenPlace,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  state: MailboxState;
  view: UnifiedAttentionView;
  /** Where decisions made on an approval's original card are followed (kept by the rail button, so they outlive this panel). */
  sessions: ApprovalSessions;
  onOpenPlace: (place: OriginalPlace) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const left = useRailEdge(anchor);

  const { read, staleRead, items, keys, ownerUserId, hosted, listedKeys } = panelRows(view, sessions);
  const { openKey, toggle } = useOpenRow(keys);
  const canRetry =
    state.kind === 'unavailable' || state.kind === 'partial' || (state.kind === 'has-items' && state.partial);
  // The state carries a count only when the read proved it, so this is exactly the rail badge's rule.
  const total = state.kind === 'has-items' ? state.count : null;

  // A hidden element can't take focus, so move focus in only once the panel is positioned and visible.
  useEffect(() => {
    if (left === null) return;
    const first =
      panelRef.current?.querySelector<HTMLElement>('[data-testid="mailbox-item-toggle"]:not(:disabled)') ??
      panelRef.current?.querySelector<HTMLElement>('[data-testid="mailbox-close"]');
    (first ?? panelRef.current)?.focus();
  }, [left]);
  useEscapeToClose(panelRef, onClose);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={MAILBOX_NAME}
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
      <PanelHeader total={total} onClose={onClose} />
      <div
        role="tabpanel"
        id="mailbox-tabpanel"
        aria-labelledby="mailbox-tab-needs-me"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[22px] pb-4"
      >
        <ReadNotes state={state} read={read} stale={staleRead !== null} />
        <RetainedResults sessions={sessions} ownerUserId={ownerUserId} listedKeys={listedKeys} />
        {items.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {items.map((item, index) => (
              <MailboxRow
                key={keys[index]}
                item={item}
                rowKey={keys[index]}
                stale={staleRead !== null}
                expanded={openKey === keys[index]}
                onToggle={() => toggle(keys[index])}
                onOpen={onOpenPlace}
                hosted={hosted}
              />
            ))}
          </ul>
        ) : null}
        {read?.page.hasMore ? (
          <p className="m-0 pt-1.5 text-xs" style={MUTED} data-testid="mailbox-has-more">
            还有更多事项，这里先显示前 {read.page.limit} 件
          </p>
        ) : null}
        {canRetry ? (
          <div className="pt-1.5">
            <button
              type="button"
              onClick={view.refetch}
              data-testid="mailbox-retry"
              className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
            >
              重试
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
