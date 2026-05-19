'use client';

import { useEffect, useRef, useState } from 'react';
import { type ThreadLabel } from '@/stores/label-store';

const MAX_INLINE = 5;

interface LabelFilterBarProps {
  labels: ThreadLabel[];
  selectedFilter: string | null;
  onSelect: (filter: string | null) => void;
  uncategorizedCount: number;
  onOrganize?: () => void;
  onManualOrganize?: () => void;
}

export function LabelFilterBar({
  labels,
  selectedFilter,
  onSelect,
  uncategorizedCount,
  onOrganize,
  onManualOrganize,
}: LabelFilterBarProps) {
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const inlineLabels = labels.slice(0, MAX_INLINE);
  const overflowLabels = labels.slice(MAX_INLINE);

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
  };

  if (labels.length === 0 && uncategorizedCount === 0) return null;

  return (
    <div className="px-3 pb-2 flex items-center gap-1 flex-wrap">
      {uncategorizedCount > 0 && (
        <button
          type="button"
          onClick={() => handleClick('__uncategorized__')}
          className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
            selectedFilter === '__uncategorized__'
              ? 'border-[var(--console-border-soft)] bg-[var(--console-field-bg)] text-cafe-black'
              : 'border-transparent text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary'
          }`}
        >
          未分类 ({uncategorizedCount})
        </button>
      )}
      {uncategorizedCount > 0 && onOrganize && (
        <button
          type="button"
          onClick={onOrganize}
          className="rounded-full px-1 py-0.5 text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-conn-amber-text"
          title="猫猫帮你分类"
        >
          <svg
            aria-hidden="true"
            className="w-3 h-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.064 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
            <path d="M20 3v4M22 5h-4" />
          </svg>
        </button>
      )}
      {uncategorizedCount > 0 && onManualOrganize && (
        <button
          type="button"
          onClick={onManualOrganize}
          className="rounded-full px-1 py-0.5 text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary"
          title="手动批量分类"
        >
          <svg
            aria-hidden="true"
            className="w-3 h-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        </button>
      )}
      {inlineLabels.map((label) => (
        <button
          key={label.id}
          type="button"
          onClick={() => handleClick(label.id)}
          className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors flex items-center gap-1 ${
            selectedFilter === label.id
              ? 'border-[var(--console-border-soft)] bg-[var(--console-field-bg)] text-cafe-black'
              : 'border-transparent text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary'
          }`}
          title={label.name}
        >
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: label.color }} />
          <span className="truncate max-w-[60px]">{label.name}</span>
        </button>
      ))}
      {overflowLabels.length > 0 && (
        <div className="relative" ref={overflowRef}>
          <button
            type="button"
            onClick={() => setShowOverflow(!showOverflow)}
            className="rounded-full px-1 py-0.5 text-[10px] text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary"
          >
            ...
          </button>
          {showOverflow && (
            <div className="absolute top-full left-0 mt-1 bg-[var(--console-card-bg)] rounded-lg shadow-lg border border-[var(--console-border-soft)] z-50 py-1 min-w-[120px]">
              {overflowLabels.map((label) => (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => {
                    handleClick(label.id);
                    setShowOverflow(false);
                  }}
                  className={`w-full text-left text-[10px] px-2 py-1 flex items-center gap-1.5 hover:bg-[var(--console-hover-bg)] ${
                    selectedFilter === label.id ? 'text-cafe-black font-medium' : 'text-cafe-muted'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: label.color }} />
                  <span className="truncate">{label.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {selectedFilter && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="ml-auto rounded-full px-1 py-0.5 text-conn-red-text hover:bg-conn-red-bg hover:text-conn-red-text"
        >
          <svg aria-hidden="true" className="w-2.5 h-2.5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />
          </svg>
        </button>
      )}
    </div>
  );
}
