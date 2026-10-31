import { useEffect, useState } from 'react';
import { MemoryEventDetail } from './MemoryEventDetail';
import { MemoryReadState } from './MemoryReadState';
import { isMemoryEventPage, type MemoryEvent, type MemoryEventPage } from './owner-memory-read';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

export function MemoryEvents({ onReadSummary }: { onReadSummary: (value: string) => void }) {
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<MemoryEvent[]>([]);
  const [selected, select] = useState<string | null>(null);
  const read = useMemoryRead<MemoryEventPage>(`/api/memory/events?limit=20&offset=${offset}`, isMemoryEventPage);
  useEffect(() => {
    if (read.data)
      setEntries((previous) =>
        offset === 0
          ? (read.data?.events ?? [])
          : [
              ...previous,
              ...(read.data?.events.filter((event) => !previous.some((item) => item.eventId === event.eventId)) ?? []),
            ],
      );
  }, [read.data, offset]);
  useEffect(() => {
    onReadSummary(
      read.error
        ? '暂时读不到'
        : read.loading && !entries.length
          ? '正在读取'
          : `${entries.length}${read.data?.meta.hasMore ? '+' : ''} 条`,
    );
  }, [read.data, read.error, read.loading, entries.length, onReadSummary]);
  const current = entries.find((entry) => entry.eventId === selected);
  const reload = () => {
    select(null);
    setOffset(0);
    read.retry();
  };
  return (
    <section className="space-y-4" aria-label="事件记忆">
      <header>
        <h1 className="text-display-sm">事件</h1>
        <p className="mt-2 text-compact text-cafe-muted">我们记录下的提醒、转变与共同经历。</p>
      </header>
      <MemoryReadState
        loading={read.loading && !entries.length}
        error={read.error && !entries.length}
        empty={!entries.length && !read.loading && !read.error}
        noun="事件"
        retry={read.retry}
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className={`space-y-3 ${current ? 'hidden lg:block' : ''}`}>
          {entries.map((entry) => (
            <article
              key={entry.eventId}
              className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4"
            >
              <button
                type="button"
                className="text-left text-base font-medium"
                aria-pressed={current?.eventId === entry.eventId}
                onClick={() => select(entry.eventId)}
              >
                {entry.type}
              </button>
              <p className="mt-2 line-clamp-3 break-words text-compact text-cafe-muted">{entry.summary}</p>
              <p className="mt-2 text-xs text-cafe-muted">
                {formatMemoryDate(entry.timestamp)}
                {entry.summaryTruncated ? ' · 较长，点击读取完整记录' : ''}
                {entry.pendingCorrectionCount !== undefined && entry.pendingCorrectionCount > 0
                  ? ` · ${entry.pendingCorrectionCount} 条纠正建议`
                  : ''}
              </p>
            </article>
          ))}
        </div>
        {current && (
          <MemoryEventDetail key={current.eventId} entry={current} close={() => select(null)} reload={reload} />
        )}
      </div>
      {read.error && entries.length > 0 && (
        <p role="alert" className="text-compact">
          较早的事件暂时读不到。
          <button type="button" onClick={read.retry} className="ml-2 text-cafe-accent underline">
            重试读取
          </button>
        </p>
      )}
      {read.data?.meta.hasMore && (
        <button
          type="button"
          disabled={read.loading}
          onClick={() => setOffset(read.data?.meta.nextOffset ?? offset)}
          className="text-compact text-cafe-accent underline"
        >
          读取更多事件
        </button>
      )}
    </section>
  );
}
