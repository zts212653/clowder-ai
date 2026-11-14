import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { MEMORY_CHANGED } from '@/hooks/memory-changed';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { MemoryDeferredPeople } from './MemoryDeferredPeople';
import { MemoryPersonDetail } from './MemoryPersonDetail';
import { MemoryPersonMaintenanceRecovery } from './MemoryPersonMaintenance';
import { MemoryReadState } from './MemoryReadState';
import { isPeoplePage, type MemoryPerson, type PeoplePage } from './people-types';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

export function MemoryPeople({ onReadSummary }: { onReadSummary?: (value: string) => void }) {
  const { ownerUserId } = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  return <MemoryPeopleView key={ownerUserId ?? 'session-pending'} onReadSummary={onReadSummary} />;
}
function MemoryPeopleView({ onReadSummary }: { onReadSummary?: (value: string) => void }) {
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<MemoryPerson[]>([]);
  const [selected, select] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const read = useMemoryRead<PeoplePage>(`/api/memory/people?limit=20&offset=${offset}`, isPeoplePage);
  useEffect(() => {
    if (read.data)
      setEntries((previous) =>
        offset === 0
          ? (read.data?.entries ?? [])
          : [
              ...previous,
              ...(read.data?.entries.filter((entry) => !previous.some((item) => item.personId === entry.personId)) ??
                []),
            ],
      );
  }, [read.data, offset]);
  useEffect(() => {
    const summary = read.error
      ? '暂时读不到'
      : read.loading && !entries.length
        ? '正在读取'
        : `${entries.length}${read.data?.meta.hasMore ? '+' : ''} 人`;
    onReadSummary?.(summary);
  }, [onReadSummary, read.error, read.loading, read.data, entries.length]);
  const changed = useCallback(() => {
    setOffset(0);
    setGeneration((n) => n + 1);
    read.retry();
  }, [read.retry]);
  useEffect(() => {
    window.addEventListener(MEMORY_CHANGED, changed);
    return () => window.removeEventListener(MEMORY_CHANGED, changed);
  }, [changed]);
  return (
    <section className="space-y-4" aria-label="人物记忆">
      <header>
        <h1 className="text-display-sm font-medium">人物</h1>
        <p className="mt-2 text-compact text-cafe-muted">你确认记住的人、关于他们的判断与共同经历。只给你看。</p>
      </header>
      {!selected && <MemoryPersonMaintenanceRecovery changed={changed} />}
      <MemoryReadState
        loading={read.loading && !entries.length}
        error={read.error && !entries.length}
        empty={!entries.length && !read.loading && !read.error}
        noun="人物记忆"
        retry={read.retry}
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className={`space-y-3 ${selected ? 'hidden lg:block' : ''}`}>
          {entries.map((person) => (
            <article
              key={person.personId}
              className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4"
            >
              <button
                type="button"
                onClick={() => select(person.personId)}
                aria-pressed={selected === person.personId}
                className="text-left text-base font-medium"
              >
                {person.displayName}
              </button>
              <p className="mt-2 text-compact text-cafe-muted">
                {person.currentClaimCount} 条当前判断 · {person.activeInteractionCount} 条共同经历
              </p>
              <p className="mt-2 text-xs text-cafe-muted">{formatMemoryDate(person.updatedAt)} · 只给你看</p>
            </article>
          ))}
        </div>
        {selected && (
          <MemoryPersonDetail
            key={`${selected}:${generation}`}
            personId={selected}
            close={() => select(null)}
            changed={changed}
          />
        )}
      </div>
      {read.error && entries.length > 0 && (
        <p role="alert" className="text-compact">
          较早的记录暂时读不到。
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
          读取更多人物
        </button>
      )}
      <MemoryDeferredPeople key={generation} />
    </section>
  );
}
