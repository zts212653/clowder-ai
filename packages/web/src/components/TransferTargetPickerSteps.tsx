import { useMemo, useState } from 'react';
import { HubIcon } from './hub-icons';

export interface TransferThreadChoice {
  id: string;
  title?: string | null;
}

export interface TransferCatChoice {
  id: string;
  displayName: string;
}

export function TransferThreadStep({
  threads,
  onSelect,
}: {
  threads: readonly TransferThreadChoice[];
  onSelect: (threadId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingThreads = useMemo(
    () =>
      normalizedQuery
        ? threads.filter((thread) =>
            `${thread.title ?? '未命名对话'} ${thread.id}`.toLocaleLowerCase().includes(normalizedQuery),
          )
        : threads,
    [normalizedQuery, threads],
  );

  if (threads.length === 0) {
    return <p className="py-8 text-center text-sm text-cafe-muted">没有可用的目标对话</p>;
  }

  return (
    <div>
      <label className="relative mb-3 block">
        <span className="sr-only">搜索目标对话</span>
        <HubIcon
          name="search"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cafe-muted"
        />
        <input
          type="search"
          aria-label="搜索目标对话"
          placeholder="搜索对话标题"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full rounded-xl border border-cafe bg-cafe-surface py-2.5 pl-9 pr-3 text-sm text-cafe-primary outline-none transition-colors placeholder:text-cafe-muted focus:border-cafe-accent focus:ring-2 focus:ring-[var(--cafe-accent-soft)]"
        />
      </label>
      {matchingThreads.length === 0 ? (
        <p className="py-8 text-center text-sm text-cafe-muted">没有匹配的目标对话</p>
      ) : (
        <div className="space-y-2">
          {matchingThreads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className="w-full rounded-xl border border-cafe px-3 py-3 text-left hover:bg-cafe-surface-sunken"
              onClick={() => onSelect(thread.id)}
            >
              <div className="truncate text-sm font-semibold text-cafe-primary">{thread.title ?? '未命名对话'}</div>
              <div className="mt-1 truncate text-xs text-cafe-muted">{thread.id}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TransferCatStep({
  cats,
  selectedCatIds,
  onToggle,
}: {
  cats: readonly TransferCatChoice[];
  selectedCatIds: ReadonlySet<string>;
  onToggle: (catId: string) => void;
}) {
  if (cats.length === 0) {
    return <p className="py-8 text-center text-sm text-cafe-muted">还没有可接收的猫猫</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {cats.map((cat) => {
        const selected = selectedCatIds.has(cat.id);
        return (
          <button
            key={cat.id}
            type="button"
            aria-pressed={selected}
            className={`rounded-xl border px-3 py-3 text-left ${selected ? 'border-cafe-accent bg-cafe-surface-sunken' : 'border-cafe hover:bg-cafe-surface-sunken'}`}
            onClick={() => onToggle(cat.id)}
          >
            <div className="text-sm font-semibold text-cafe-primary">{cat.displayName}</div>
            <div className="mt-1 text-xs text-cafe-muted">@{cat.id}</div>
          </button>
        );
      })}
    </div>
  );
}
