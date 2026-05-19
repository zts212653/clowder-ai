import type React from 'react';
import type { SignalArticleFilters } from '@/utils/signals-view';

const SELECT_CLASS =
  'h-8 appearance-none rounded-lg bg-[var(--console-card-bg)] px-2 text-xs text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] outline-none';

interface SignalFilterBarProps {
  filters: SignalArticleFilters;
  onFilterChange: (patch: Partial<SignalArticleFilters>) => void;
  onStatusTab: (status: SignalArticleFilters['status']) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  sources: readonly string[];
  ime: { onCompositionStart: () => void; onCompositionEnd: () => void; isComposing: () => boolean };
}

export function SignalFilterBar({
  filters,
  onFilterChange,
  onStatusTab,
  onSubmit,
  sources,
  ime,
}: SignalFilterBarProps) {
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-1.5 px-1 pb-1">
      <div className="flex flex-1 items-center gap-1.5 rounded-lg bg-[var(--console-card-bg)] px-2.5 h-8 shadow-[0_1px_3px_rgba(43,33,26,0.06)]">
        <svg
          className="h-[13px] w-[13px] text-cafe-muted"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          value={filters.query}
          onChange={(e) => onFilterChange({ query: e.target.value })}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ime.isComposing()) e.preventDefault();
          }}
          placeholder="搜索信号..."
          className="min-w-0 flex-1 bg-transparent text-xs text-cafe-black outline-none placeholder:text-cafe-muted"
        />
      </div>
      <select
        value={filters.status}
        onChange={(e) => onStatusTab(e.target.value as SignalArticleFilters['status'])}
        className={SELECT_CLASS}
        name="status"
      >
        <option value="inbox">Inbox</option>
        <option value="starred">收藏</option>
        <option value="read">已读</option>
        <option value="archived">归档</option>
        <option value="all">全部</option>
      </select>
      <select
        value={filters.tier}
        onChange={(e) => onFilterChange({ tier: e.target.value as SignalArticleFilters['tier'] })}
        name="tier"
        className={SELECT_CLASS}
      >
        <option value="all">Tier</option>
        <option value="1">T1</option>
        <option value="2">T2</option>
        <option value="3">T3</option>
        <option value="4">T4</option>
      </select>
      <select
        value={filters.source}
        onChange={(e) => onFilterChange({ source: e.target.value })}
        name="source"
        className={SELECT_CLASS}
      >
        <option value="all">全部来源</option>
        {sources.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </form>
  );
}
