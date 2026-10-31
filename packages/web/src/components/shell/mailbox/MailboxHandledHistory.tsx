import {
  APPROVAL_PRODUCER_IDS,
  compareApprovalHistoryId,
  ignoredItemKey,
  type UnifiedAttentionItemV1,
} from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { ProposalChoice } from '@/components/rich/ProposalChoice';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import type { UnifiedAttentionView } from '../use-unified-attention';
import { HandledApprovalRow, producerKind } from './HandledApprovalRow';
import { HandledAttentionRow } from './HandledAttentionRow';
import { HistoryReadNotes } from './HistoryReadNotes';
import { handledHistoryCopy } from './handled-history.shell-copy';
import type { HandledHistoryRead, HandledHistorySnapshot } from './handled-history-read';
import { historyReadState } from './history-read-state';
import { MailboxMentionUndo } from './MailboxMentionUndo';
import type { MailboxSection } from './mailbox-navigation';
import type { OriginalPlace } from './original-place';
import { settledResultKey } from './settled-results-source';
import type { useMailboxPersonalPreferences } from './use-mailbox-personal-preferences';

export function MailboxHandledHistory({
  snapshot,
  read,
  section,
  view,
  personal,
  onSectionChange,
  onOpenPlace,
  verifyCurrent,
}: {
  section: 'history' | 'ignored';
  view: UnifiedAttentionView;
  personal: ReturnType<typeof useMailboxPersonalPreferences>;
  onSectionChange?: (section: MailboxSection) => void;
  snapshot: HandledHistorySnapshot | null;
  read: HandledHistoryRead;
  onOpenPlace: (place: OriginalPlace) => void;
  verifyCurrent: () => boolean;
}) {
  const t = useShellCopy(handledHistoryCopy),
    language = useShellLanguage();
  const [tab, setTab] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [kind, setKind] = useState('all');
  const [visibleLimit, setVisibleLimit] = useState(30);
  const currentTab = section === 'ignored' ? 'ignored' : tab;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new display query starts with one 30-item window.
  useEffect(() => setVisibleLimit(30), [currentTab, outcome, kind]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const ownerRead = view.result.kind === 'ok' ? view.result.read : view.staleRead;
  const owner = ownerRead?.identity.ownerUserId;
  const preferenceRevision = ownerRead?.personalView?.preferenceRevision;
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection is scoped to this owner, preference revision and tab.
  useEffect(() => {
    setSelected(new Set());
    setSelecting(false);
  }, [owner, preferenceRevision, currentTab]);
  const items = snapshot?.items;
  const decisionItems =
    items?.filter(
      (item) =>
        (outcome === 'all' ||
          (outcome === 'selected'
            ? item.sourceFeatureId === 'F306' && Array.isArray(item.detail.runtimeSelectedLabels)
            : item.resolution === outcome)) &&
        (kind === 'all' || item.sourceFeatureId === kind),
    ) ?? [];
  const attentionWindow = [
    ...new Map(
      [...(view.pages?.length ? view.pages : ownerRead ? [ownerRead] : [])]
        .reverse()
        .filter((page) => page.identity.ownerUserId === owner)
        .flatMap((page) => page.items)
        .map((item) => [item.decisionRef, item]),
    ).values(),
  ];
  const attentionItems = attentionWindow.filter(
    (item) => currentTab === 'ignored' || (item.kind === 'user_mention' && item.userMention?.handled === true),
  );
  const filteredAttention = attentionItems.filter((item) => {
    const reason = item.userMention?.handledReason;
    return (
      (kind === 'all' || (kind === 'user_mention' ? !!item.userMention : item.approval?.sourceFeatureId === kind)) &&
      (outcome === 'all' ||
        (outcome === 'ignored'
          ? currentTab === 'ignored' || reason === 'ignored'
          : outcome === 'viewed' || outcome === 'replied'
            ? reason === outcome
            : false))
    );
  });
  const kinds = APPROVAL_PRODUCER_IDS;
  const attentionMore = (view.pages?.at(-1) ?? ownerRead)?.page.hasMore === true;
  const availableRecords =
    currentTab === 'decisions'
      ? (items?.length ?? 0)
      : currentTab === 'all'
        ? (items?.length ?? 0) + attentionItems.length
        : attentionItems.length;
  const more =
    currentTab === 'ignored' || currentTab === 'mentions'
      ? attentionMore
      : snapshot?.hasMore || (currentTab === 'all' && attentionMore);
  const loadMore = () => {
    setVisibleLimit((count) => count + 30);
    if (rows.length >= visibleLimit + 30) return;
    if (currentTab !== 'ignored' && currentTab !== 'mentions') void read.loadMore();
    if (currentTab !== 'decisions' && attentionMore && view.result.kind !== 'loading') view.nextPage?.();
  };
  type HistoryRow =
    | { type: 'approval'; item: NonNullable<typeof items>[number]; at: number; key: string }
    | { type: 'attention'; item: UnifiedAttentionItemV1; at: number; key: string };
  const rows: HistoryRow[] = [
    ...(currentTab === 'all' || currentTab === 'decisions'
      ? decisionItems.map((item) => ({
          type: 'approval' as const,
          item,
          at: item.decidedAt,
          key: `${item.sourceFeatureId}:${item.proposalId}`,
        }))
      : []),
    ...(currentTab !== 'decisions'
      ? filteredAttention.map((item) => ({
          type: 'attention' as const,
          item,
          at:
            currentTab === 'ignored' && item.preferenceCoordinate
              ? (personal.ignoredEntries.find(
                  (entry) => ignoredItemKey(entry.coordinate) === ignoredItemKey(item.preferenceCoordinate!),
                )?.ignoredAt ?? 0)
              : (item.userMention?.handledAt ?? item.userMention?.timestamp ?? 0),
          key: item.decisionRef,
        }))
      : []),
  ];
  rows.sort((a, b) => b.at - a.at || compareApprovalHistoryId(a.key, b.key));
  const groups = new Map<string, HistoryRow[]>();
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startWeek = startToday - ((now.getDay() + 6) % 7) * 86400_000;
  for (const row of rows.slice(0, visibleLimit)) {
    const key =
      row.at === 0
        ? t.unknownTime
        : row.at >= startToday
          ? t.today
          : row.at >= startToday - 86400_000
            ? t.yesterday
            : row.at >= startWeek
              ? t.week
              : t.earlier;
    const day = groups.get(key) ?? [];
    day.push(row);
    groups.set(key, day);
  }
  const changeTab = (next: string) => {
    setTab(next);
    setSelecting(false);
    setSelected(new Set());
    if (next === 'ignored') onSectionChange?.('ignored');
    else if (section === 'ignored') onSectionChange?.('history');
  };
  return (
    <section data-testid="mailbox-handled-history" className="flex min-h-0 flex-1 flex-col px-[22px] pb-4">
      <nav className="mb-3 flex rounded-lg p-1 text-sm" style={{ background: 'var(--shell-frame)' }}>
        {(['all', 'decisions', 'mentions', 'ignored'] as const).map((key) => (
          <button
            key={key}
            data-testid={`mailbox-history-tab-${key}`}
            type="button"
            className="shell-focusable flex-1 rounded-md px-2 py-1.5"
            aria-current={currentTab === key ? 'page' : undefined}
            style={{ background: currentTab === key ? 'var(--shell-paper)' : undefined }}
            onClick={() => changeTab(key)}
          >
            {t[key]}
          </button>
        ))}
      </nav>
      <div className="mb-3 flex gap-2">
        <ProposalChoice
          label={t.result}
          triggerLabel={outcome === 'all' ? t.result : undefined}
          value={outcome}
          disabled={false}
          options={[
            { value: 'all', label: t.all },
            { value: 'accepted', label: t.accepted },
            { value: 'rejected', label: t.rejected },
            { value: 'closed_without_decision', label: t.closed },
            { value: 'selected', label: t.selected },
            { value: 'viewed', label: t.viewed },
            { value: 'replied', label: t.replied },
            { value: 'ignored', label: t.ignoredResult },
          ]}
          onChange={setOutcome}
        />
        <ProposalChoice
          label={t.kind}
          triggerLabel={kind === 'all' ? t.kind : undefined}
          value={kind}
          disabled={false}
          options={[
            { value: 'all', label: t.all },
            { value: 'user_mention', label: t.mentions },
            ...kinds.map((value) => ({ value, label: producerKind(value, language) })),
          ]}
          onChange={setKind}
        />
      </div>
      {currentTab === 'ignored' ? (
        <div className="mb-2 flex gap-2 text-xs">
          <button
            type="button"
            className="shell-focusable hover:underline"
            data-testid="mailbox-history-select"
            onClick={() => {
              setSelecting(!selecting);
              setSelected(new Set());
            }}
          >
            {selecting ? t.cancel : t.select}
          </button>
          {selecting ? (
            <button
              type="button"
              className="shell-focusable hover:underline disabled:opacity-50"
              data-testid="mailbox-history-restore-selected"
              disabled={!selected.size || personal.restoreBatchRefusal !== null}
              onClick={async () => {
                if (await personal.restoreBatch(filteredAttention.filter((item) => selected.has(item.decisionRef)))) {
                  setSelected(new Set());
                  setSelecting(false);
                }
              }}
            >
              {t.restoreSelected}
            </button>
          ) : null}
        </div>
      ) : null}
      {currentTab === 'mentions' ? <MailboxMentionUndo owner={owner} disabled={!verifyCurrent()} /> : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="mailbox-history-content"
        onScroll={(event) => {
          const node = event.currentTarget;
          if (node.scrollHeight - node.scrollTop - node.clientHeight < 96) loadMore();
        }}
      >
        <HistoryReadNotes tab={currentTab} snapshot={snapshot} view={view} read={read} hasRows={rows.length > 0} />
        {historyReadState(currentTab, snapshot, view).canClaimEmpty && rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--shell-muted)]">
            {more || availableRecords > 0 ? t.filteredEmpty : currentTab === 'ignored' ? t.ignoredEmpty : t.empty}
          </p>
        ) : null}
        {[...groups].map(([label, rows]) => (
          <section key={label} aria-label={label}>
            <h3 className="mb-1 mt-3 text-xs font-normal text-[var(--shell-muted)]">{label}</h3>
            <ul className="m-0 list-none p-0">
              {rows.map((row) =>
                row.type === 'approval' ? (
                  <HandledApprovalRow
                    key={row.key}
                    item={row.item}
                    reread={() => void read.refresh()}
                    authorizeOpen={() =>
                      snapshot?.status === 'ready' &&
                      snapshot.currentKeys.has(settledResultKey(row.item)) &&
                      verifyCurrent()
                    }
                    onOpenPlace={onOpenPlace}
                  />
                ) : (
                  <HandledAttentionRow
                    key={row.key}
                    item={row.item}
                    ignored={currentTab === 'ignored'}
                    at={row.at}
                    readCurrent={
                      view.result.kind === 'ok' &&
                      verifyCurrent() &&
                      (view.currentPages ?? (ownerRead ? [ownerRead] : [])).some((page) =>
                        page.items.some(
                          (item) =>
                            item.decisionRef === row.item.decisionRef &&
                            item.userMention?.messageId === row.item.userMention?.messageId &&
                            item.userMention?.expectedRevision === row.item.userMention?.expectedRevision,
                        ),
                      )
                    }
                    personal={personal.actions}
                    onOpenPlace={onOpenPlace}
                    selection={
                      selecting && currentTab === 'ignored'
                        ? {
                            checked: selected.has(row.item.decisionRef),
                            disabled: !personal.actions || personal.actions.refusal(row.item) !== null,
                            toggle: () =>
                              setSelected((before) => {
                                const next = new Set(before);
                                if (next.has(row.item.decisionRef)) next.delete(row.item.decisionRef);
                                else next.add(row.item.decisionRef);
                                return next;
                              }),
                          }
                        : undefined
                    }
                  />
                ),
              )}
            </ul>
          </section>
        ))}
        {more || rows.length > visibleLimit ? (
          <div className="py-3 text-center text-xs text-[var(--shell-muted)]">
            {outcome !== 'all' || kind !== 'all' ? <p>{t.windowFilter(items?.length ?? 0)}</p> : null}
            <button
              type="button"
              data-testid="mailbox-history-load-more"
              className="shell-focusable underline disabled:opacity-50"
              disabled={snapshot?.loadingMore || snapshot?.status === 'reading' || view.result.kind === 'loading'}
              onClick={loadMore}
            >
              {snapshot?.loadingMore ? t.readingMore : snapshot?.moreFailed ? t.retry : t.readMore}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
