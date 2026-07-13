'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type ThreadLabel } from '@/stores/label-store';

const MAX_INLINE = 5;

interface LabelFilterBarProps {
  labels: ThreadLabel[];
  selectedFilter: string | null;
  onSelect: (filter: string | null) => void;
  uncategorizedCount: number;
}

export function LabelFilterBar({ labels, selectedFilter, onSelect, uncategorizedCount }: LabelFilterBarProps) {
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const visibleLabels = labels.slice(0, MAX_INLINE);
  const overflowLabels = labels.slice(MAX_INLINE);
  const selectedLabel =
    selectedFilter === '__uncategorized__'
      ? '未分类'
      : (labels.find((label) => label.id === selectedFilter)?.name ?? null);

  useEffect(() => {
    if (!showOverflow) return;
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showOverflow]);

  const handleClick = (filter: string | null) => {
    onSelect(selectedFilter === filter ? null : filter);
    setShowOverflow(false);
  };

  return (
    <div className="relative flex-shrink-0" ref={overflowRef}>
      <button
        type="button"
        onClick={() => setShowOverflow((open) => !open)}
        className={`flex h-full items-center gap-1 rounded-t-md border-b-2 px-1.5 py-1.5 text-micro font-medium transition-colors ${
          selectedFilter
            ? 'border-cafe-accent text-cafe-accent'
            : 'border-transparent text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary'
        }`}
        data-testid="sidebar-label-filter-trigger"
        aria-haspopup="menu"
        aria-expanded={showOverflow}
      >
        <TagIcon />
        {selectedLabel ? <span className="max-w-[72px] truncate">{selectedLabel}</span> : <span>标签</span>}
      </button>

      {showOverflow && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] py-1 shadow-lg"
          data-testid="sidebar-label-filter-menu"
          role="menu"
        >
          <FilterMenuItem selected={!selectedFilter} onClick={() => handleClick(null)}>
            全部对话
          </FilterMenuItem>
          <FilterMenuItem
            selected={selectedFilter === '__uncategorized__'}
            onClick={() => handleClick('__uncategorized__')}
          >
            未分类{uncategorizedCount > 0 ? ` (${uncategorizedCount})` : ''}
          </FilterMenuItem>
          {visibleLabels.map((label) => (
            <FilterMenuItem
              key={label.id}
              selected={selectedFilter === label.id}
              onClick={() => handleClick(label.id)}
              color={label.color}
            >
              {label.name}
            </FilterMenuItem>
          ))}
          {overflowLabels.length > 0 && <div className="my-1 h-px bg-cafe-subtle" />}
          {overflowLabels.map((label) => (
            <FilterMenuItem
              key={label.id}
              selected={selectedFilter === label.id}
              onClick={() => handleClick(label.id)}
              color={label.color}
            >
              {label.name}
            </FilterMenuItem>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterMenuItem({
  children,
  selected,
  onClick,
  color,
}: {
  children: ReactNode;
  selected: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-micro transition-colors hover:bg-[var(--console-hover-bg)] ${
        selected ? 'font-medium text-cafe-black' : 'text-cafe-muted'
      }`}
    >
      {color ? (
        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
      ) : (
        <span className="h-2 w-2 flex-shrink-0 rounded-full border border-cafe-subtle" />
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

function TagIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <path d="M7.5 7.5h.01" />
    </svg>
  );
}
