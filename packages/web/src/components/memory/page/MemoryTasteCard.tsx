import { CatAvatar } from '@/components/CatAvatar';
import { LockIcon } from '@/components/HubConfigIcons';
import { useCatData } from '@/hooks/useCatData';
import { currentTakeawayCandidate, tasteCardLead, tasteQuote, tasteRecordedDate, tasteTime } from './taste-format';
import { type TasteMemory, tasteDimension } from './taste-types';

export function TasteMetadata({ entry }: { entry: TasteMemory }) {
  const { getCatById, isLoading } = useCatData();
  const cat = entry.catId ? getCatById(entry.catId) : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-cafe-muted">
      {cat && entry.catId ? (
        <span className="inline-flex items-center gap-1">
          <CatAvatar catId={entry.catId} size={20} />
          {cat.nickname || cat.displayName}
        </span>
      ) : (
        <span>{entry.catId ? (isLoading ? '正在读取猫的名字…' : '猫的名字暂时读不到') : '记录猫没有记下来'}</span>
      )}
      <time>
        {entry.approval?.status === 'approved' && typeof entry.approval.proposedAt === 'number'
          ? tasteTime(entry.approval.proposedAt)
          : `记录日期 ${tasteRecordedDate(entry.when)} · ${entry.approval?.status === 'unavailable' ? '提出时间暂时读不到' : '提出时间没有记录下来'}`}
      </time>
      <span>{tasteDimension(entry.dimension)}</span>
      {entry.visibility === 'private' && (
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true">
            <LockIcon />
          </span>
          只给你看
        </span>
      )}
    </div>
  );
}
export function MemoryTasteCard({
  entry,
  selected,
  select,
}: {
  entry: TasteMemory;
  selected: boolean;
  select: () => void;
}) {
  return (
    <article
      className={`rounded-xl border bg-[var(--console-card-bg)] p-4 ${selected ? 'border-cafe-accent' : 'border-cafe-subtle'}`}
      data-testid="taste-card"
      data-memory-id={entry.id}
    >
      <button type="button" onClick={select} aria-pressed={selected} className="w-full text-left">
        <span className="mb-2 block text-xs text-cafe-muted">
          {currentTakeawayCandidate(entry)
            ? '猫整理的一句话 · 假设 · 待你确认'
            : entry.takeaway
              ? '猫整理的一句话 · 假设'
              : '还没有整理成一句话 · 原话'}
        </span>
        <p className="line-clamp-3 break-words text-sm">{tasteCardLead(entry)}</p>
        <p className="mt-2 line-clamp-2 break-words text-compact text-cafe-muted">
          {entry.takeaway
            ? entry.quotes[0]
              ? tasteQuote(entry.quotes[0])
              : '原话没有记录下来'
            : `当时：${entry.scene}`}
        </p>
        <div className="mt-3">
          <TasteMetadata entry={entry} />
        </div>
        {entry.pendingCorrectionCount !== undefined && entry.pendingCorrectionCount > 0 && (
          <p className="mt-2 text-compact text-cafe-muted">{entry.pendingCorrectionCount} 条纠正建议</p>
        )}
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-cafe-muted">
          {entry.recall === null ? (
            <span>暂时读不到被想起记录</span>
          ) : (
            <>
              {entry.recall.namedDelivery && entry.recall.namedDelivery.counts.presented > 0 && (
                <span className="whitespace-nowrap">点名递送 {entry.recall.namedDelivery.counts.presented} 次</span>
              )}
              {entry.recall.search && entry.recall.search.hits > 0 && (
                <span className="whitespace-nowrap">检索命中 {entry.recall.search.hits} 次</span>
              )}
            </>
          )}
        </p>
      </button>
    </article>
  );
}
