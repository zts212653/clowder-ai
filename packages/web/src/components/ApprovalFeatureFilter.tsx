'use client';

import type { ApprovalFeatureId } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { APPROVAL_FEATURE_IDS, approvalFeatureMeta } from '@/lib/approval-features';

interface ApprovalFeatureFilterProps {
  selected: ReadonlySet<ApprovalFeatureId>;
  counts: Partial<Record<ApprovalFeatureId, number>>;
  onChange: (selected: Set<ApprovalFeatureId>) => void;
  testIdPrefix: 'approval-filter' | 'approval-history-filter';
}

export function ApprovalFeatureFilter({ selected, counts, onChange, testIdPrefix }: ApprovalFeatureFilterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const toggleFeature = (featureId: ApprovalFeatureId) => {
    const next = new Set(selected);
    if (next.has(featureId)) next.delete(featureId);
    else next.add(featureId);
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="flex min-w-0 flex-wrap items-center gap-1.5">
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={`flex items-center gap-1 rounded-md border px-2 py-1 text-micro font-medium transition-colors ${
            selected.size > 0
              ? 'border-cafe-accent/50 bg-cafe-surface text-cafe-interactive'
              : 'border-cafe-subtle/30 text-cafe-interactive/55 hover:border-cafe-subtle/60 hover:text-cafe-interactive'
          }`}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid={`${testIdPrefix}-feature-trigger`}
        >
          <FilterIcon />
          <span>类型</span>
          {selected.size > 0 && (
            <span className="rounded-full bg-cafe-subtle/25 px-1 text-micro leading-4">{selected.size}</span>
          )}
          <ChevronIcon open={open} />
        </button>

        {open && (
          <div
            className="absolute left-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] py-1 shadow-lg"
            role="menu"
            data-testid={`${testIdPrefix}-feature-menu`}
          >
            <FeatureOption
              label="全部类型"
              count={Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0)}
              selected={selected.size === 0}
              onClick={() => {
                onChange(new Set());
                setOpen(false);
              }}
              testId={`${testIdPrefix}-feature-all`}
            />
            <div className="my-1 h-px bg-cafe-subtle/25" />
            {APPROVAL_FEATURE_IDS.map((featureId) => {
              const meta = approvalFeatureMeta(featureId);
              return (
                <FeatureOption
                  key={featureId}
                  label={meta.label}
                  count={counts[featureId] ?? 0}
                  color={meta.color}
                  selected={selected.has(featureId)}
                  onClick={() => toggleFeature(featureId)}
                  testId={`${testIdPrefix}-feature-${featureId}`}
                />
              );
            })}
          </div>
        )}
      </div>

      {APPROVAL_FEATURE_IDS.filter((featureId) => selected.has(featureId)).map((featureId) => {
        const meta = approvalFeatureMeta(featureId);
        return (
          <button
            key={featureId}
            type="button"
            onClick={() => toggleFeature(featureId)}
            className="flex items-center gap-1 rounded-full border border-cafe-subtle/30 bg-cafe-surface/70 px-2 py-0.5 text-micro text-cafe-interactive/70 hover:border-cafe-subtle/60 hover:text-cafe-interactive"
            title={`移除${meta.label}筛选`}
            data-testid={`${testIdPrefix}-active-${featureId}`}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
            {meta.label}
            <span aria-hidden="true" className="opacity-50">
              ×
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FeatureOption({
  label,
  count,
  color,
  selected,
  onClick,
  testId,
}: {
  label: string;
  count: number;
  color?: string;
  selected: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={selected}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-micro transition-colors hover:bg-[var(--console-hover-bg)] ${
        selected ? 'font-medium text-cafe-interactive' : 'text-cafe-interactive/60'
      }`}
      data-testid={testId}
    >
      <span
        className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
          selected ? 'border-cafe-accent bg-cafe-accent text-[var(--cafe-accent-foreground)]' : 'border-cafe-subtle/60'
        }`}
      >
        {selected && <CheckIcon />}
      </span>
      {color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="tabular-nums text-cafe-interactive/35">{count}</span>
    </button>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
      <title>筛选类型</title>
      <path d="M4 6h16M7 12h10m-7 6h4" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
      aria-hidden="true"
    >
      <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-2.5 w-2.5"
      aria-hidden="true"
    >
      <path d="m3 8 3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
