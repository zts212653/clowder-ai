'use client';
import type { RememberGroupRow, RichCardBlock } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { useShellCopy } from '../shell/shell-copy';
import { MemoryGroupRequestChanges } from './MemoryGroupRequestChanges';
import { memoryGroupCopy } from './memory-group.shell-copy';
import {
  isMemoryGroupProposal,
  type OriginalMemoryGroupCard,
  readMemoryGroup,
  readMemoryGroupOriginals,
} from './memory-group-source';

type RenderOriginal = (original: RichCardBlock, coordinate: PublishedMessageCoordinate) => ReactNode;
export function MemoryGroupCard({
  block,
  coordinate,
  renderOriginal,
}: {
  block: RichCardBlock;
  coordinate?: { threadId: string; messageId: string };
  renderOriginal: RenderOriginal;
}) {
  const t = useShellCopy(memoryGroupCopy);
  const group = useMemo(() => readMemoryGroup(block), [block]);
  const [reload, setReload] = useState(0);
  const key = JSON.stringify([coordinate?.threadId, group, reload]);
  const [read, setRead] = useState<{
    key: string;
    loading: boolean;
    cards: Record<string, OriginalMemoryGroupCard>;
  } | null>(null);
  const threadId = coordinate?.threadId;
  useEffect(() => {
    if (!group || !threadId) return;
    const controller = new AbortController();
    setRead({ key, loading: true, cards: {} });
    void readMemoryGroupOriginals(group, threadId, controller.signal)
      .then((cards) => {
        if (!controller.signal.aborted) setRead({ key, loading: false, cards });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRead({ key, loading: false, cards: {} });
      });
    return () => controller.abort();
  }, [group, threadId, key]);
  if (!group) return <output>{t.invalid}</output>;
  const cards = read?.key === key ? read.cards : {};
  const loading = read?.key !== key || read.loading;
  return (
    <section
      data-memory-group-id={group.groupId}
      aria-label={t.title}
      className="space-y-3 rounded-xl border border-cafe p-3"
    >
      <header className="flex items-center justify-between gap-3 text-sm">
        <h3 className="font-medium">{t.title}</h3>
        <span className="text-xs text-cafe-muted">{t.count(group.rows.length)}</span>
      </header>
      <div className="space-y-3">
        {group.rows.map((row) => (
          <div key={row.itemId} data-memory-group-row={row.itemId}>
            <MemoryGroupRow row={row} original={cards[row.itemId]} loading={loading} renderOriginal={renderOriginal} />
          </div>
        ))}
      </div>
      {!loading && group.rows.some((row) => isMemoryGroupProposal(row) && !cards[row.itemId]) ? (
        <button
          type="button"
          className="shell-focusable rounded px-2 py-1 text-xs"
          onClick={() => setReload((n) => n + 1)}
        >
          {t.reread}
        </button>
      ) : null}
    </section>
  );
}
function MemoryGroupRow({
  row,
  original,
  loading,
  renderOriginal,
}: {
  row: RememberGroupRow;
  original?: OriginalMemoryGroupCard;
  loading: boolean;
  renderOriginal: RenderOriginal;
}) {
  const t = useShellCopy(memoryGroupCopy);
  if (original && original.proposalId === row.proposalId)
    return (
      <>
        {renderOriginal(original.block, original.coordinate)}
        <MemoryGroupRequestChanges original={original} />
      </>
    );
  if (isMemoryGroupProposal(row))
    return (
      <div className="space-y-1 text-sm">
        <h4 className="text-xs text-cafe-muted">{t.kinds[row.target]}</h4>
        <output>{loading ? t.loading : t.unreadable}</output>
      </div>
    );
  const statuses: Partial<Record<string, string>> = {
    saved: t.saved,
    updated: t.saved,
    written: t.saved,
    applied: t.saved,
    deferred: t.deferred,
    joined: t.joined,
    deduped: t.joined,
    unavailable: t.unavailable,
    refused: t.refused,
    stale_ignored: t.refused,
  };
  const text =
    row.statusCode >= 400 || row.error
      ? t.refused
      : row.target === 'person_abstain' || row.status === 'abstained'
        ? t.abstained
        : (statuses[row.status ?? ''] ?? t.completed);
  return (
    <div className="space-y-1 text-sm">
      <h4 className="text-xs text-cafe-muted">{t.kinds[row.target]}</h4>
      <output>{text}</output>
      {row.error ? <p className="text-cafe-muted">{row.error}</p> : null}
    </div>
  );
}
