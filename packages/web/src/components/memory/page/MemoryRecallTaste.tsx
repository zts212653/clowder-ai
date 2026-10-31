import { useState } from 'react';
import { MemoryReadState } from './MemoryReadState';
import { MemoryTasteDetail } from './MemoryTasteDetail';
import { currentTakeawayCandidate, tasteCardLead } from './taste-format';
import type { TasteBrowse } from './taste-types';
import type { MemoryRead } from './use-memory-read';
export function MemoryRecallTaste({ taste }: { taste: MemoryRead<TasteBrowse> }) {
  const [selectedId, select] = useState<string | null>(null);
  const entries = taste.data?.entries ?? [];
  const ranked = entries
    .filter((entry) => entry.recall?.search && entry.recall.search.hits > 0)
    .sort((a, b) => (b.recall?.search?.hits ?? 0) - (a.recall?.search?.hits ?? 0) || a.when.localeCompare(b.when))
    .slice(0, 5);
  const selected = entries.find((entry) => entry.id === selectedId);
  return (
    <section className="mt-5 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4 md:p-5">
      <h2 className="text-base font-medium">
        检索命中最多的品味<span className="ml-2 text-xs font-normal text-cafe-muted">全部时间</span>
      </h2>
      <p className="my-2 text-xs text-cafe-muted">命中表示检索找到这条品味；是否采用，以精确点名回报为准。</p>
      <MemoryReadState
        loading={taste.loading}
        error={taste.error}
        empty={ranked.length === 0 && taste.data?.readStatus !== 'partial'}
        noun="品味检索命中记录"
        retry={taste.retry}
      />
      {taste.data?.readStatus === 'partial' && (
        <output className="my-2 block text-compact text-cafe-muted">
          部分读到：有些品味的检索记录暂时读不到。
          <button type="button" onClick={taste.retry} className="ml-2 text-cafe-accent underline">
            重读
          </button>
        </output>
      )}
      {ranked.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => select(entry.id)}
          className="flex w-full items-center gap-3 border-b border-cafe-subtle py-3 text-left text-compact"
        >
          <span className="text-cafe-muted">{index + 1}</span>
          <span className="min-w-0 flex-1 break-words">
            {tasteCardLead(entry)}
            {currentTakeawayCandidate(entry) && <span className="ml-2 text-xs text-cafe-muted">假设 · 待你确认</span>}
            {entry.visibility === 'private' && <span className="ml-2 text-xs text-cafe-muted">只给你看</span>}
          </span>
          <span className="shrink-0 text-right text-xs text-cafe-muted">
            <span className="block">命中 {entry.recall?.search?.hits} 次</span>
            <span className="mt-1 block">点开 {entry.recall?.search?.opened} 次</span>
          </span>
        </button>
      ))}
      {taste.data && (
        <p className="mt-3 text-xs text-cafe-muted">
          {taste.data.coverage
            ? `${taste.data.coverage.unverified} 次命中尚未核对到当前品味`
            : '命中覆盖情况暂时读不到'}
        </p>
      )}
      {selected && (
        <div className="mt-4">
          <MemoryTasteDetail
            key={`${selected.id}@${selected.revision}`}
            entry={selected}
            close={() => select(null)}
            reload={() => {
              select(null);
              taste.retry();
            }}
          />
        </div>
      )}
    </section>
  );
}
