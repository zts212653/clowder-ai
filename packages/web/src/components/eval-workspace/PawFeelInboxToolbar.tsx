'use client';

import type { PawFeelInboxPage, PawFeelInboxSort } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { usePawFeelCopy } from '../paw-feel/paw-feel.shell-copy';
import { CheckIcon, ChevronDownIcon, DetailsIcon, FilterIcon, SortIcon } from './PawFeelInboxIcons';

export type PawFeelFilter = 'active' | 'all' | 'overdue' | 'disposed';

export function PawFeelInboxToolbar({
  page,
  filter,
  sort,
  newCount,
  dutyConfigured,
  onFilter,
  onSort,
  onNewest,
}: {
  page: PawFeelInboxPage | null;
  filter: PawFeelFilter;
  sort: PawFeelInboxSort;
  newCount: number;
  dutyConfigured: boolean;
  onFilter: (filter: PawFeelFilter) => void;
  onSort: (sort: PawFeelInboxSort) => void;
  onNewest: () => void;
}) {
  const t = usePawFeelCopy();
  const FILTER_LABELS = t.filters;
  const SORT_LABELS = t.sorts;
  const filterCounts: Record<PawFeelFilter, number> = {
    active: page?.issueCounts.open ?? 0,
    all: page?.bundleCounts.total ?? 0,
    overdue: page?.issueCounts.overdue ?? 0,
    disposed: page?.issueCounts.resolved ?? 0,
  };

  return (
    <div className="mt-4 min-w-0">
      {page ? (
        <dl
          className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-2 rounded-xl bg-[var(--console-card-bg)] px-3 py-2.5 shadow-[var(--console-shadow-soft)]"
          data-testid="paw-feel-primary-summary"
        >
          <SummaryMetric label="issue-open" value={page.issueCounts.open} alert={page.issueCounts.overdue > 0} />
          <SummaryMetric label="issue-resolved" value={page.issueCounts.resolved} />
          <SummaryMetric label="unreviewed" value={page.responsibilityCounts.unreviewed} />
          <SummaryMetric label="bound-in-repair" value={page.responsibilityCounts.bound_in_repair} />
          <SummaryMetric label="signature-waiting" value={page.responsibilityCounts.signature_waiting} />
          <SummaryMetric label="blocked" value={page.responsibilityCounts.blocked} />
          <SummaryMetric label="terminal" value={page.responsibilityCounts.terminal} />
          <SummaryMetric label="issue 72h+" value={page.issueCounts.overdue} alert={page.issueCounts.overdue > 0} />
        </dl>
      ) : null}

      <fieldset className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <legend className="sr-only">{t.controls}</legend>
        <ControlPopover
          icon={<FilterIcon />}
          label={`${t.status} · ${FILTER_LABELS[filter]}`}
          popoverKind="menu"
          testId="paw-feel-filter"
        >
          {(close) => (
            <div className="py-1">
              {(Object.keys(FILTER_LABELS) as PawFeelFilter[]).map((key) => (
                <MenuOption
                  key={key}
                  selected={filter === key}
                  label={FILTER_LABELS[key]}
                  count={filterCounts[key]}
                  onClick={() => {
                    onFilter(key);
                    close();
                  }}
                />
              ))}
            </div>
          )}
        </ControlPopover>

        <ControlPopover
          icon={<SortIcon />}
          label={`${t.sort} · ${SORT_LABELS[sort]}`}
          popoverKind="menu"
          testId="paw-feel-sort"
        >
          {(close) => (
            <div className="py-1">
              {(Object.keys(SORT_LABELS) as PawFeelInboxSort[]).map((key) => (
                <MenuOption
                  key={key}
                  selected={sort === key}
                  label={SORT_LABELS[key]}
                  onClick={() => {
                    onSort(key);
                    close();
                  }}
                />
              ))}
            </div>
          )}
        </ControlPopover>

        <ControlPopover
          align="right"
          icon={<DetailsIcon />}
          label={t.details}
          popoverKind="dialog"
          testId="paw-feel-details"
        >
          {() => (
            <div className="w-[min(19rem,calc(100vw-2.5rem))] px-3 py-3 text-xs">
              <p className="font-semibold text-cafe">{t.denominator}</p>
              <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-cafe-secondary">
                <DetailMetric label={t.reports} value={page?.denominator.reportOccurrences ?? 0} />
                <DetailMetric label={t.sourceMessages} value={page?.denominator.uniqueSourceMessages ?? 0} />
                <DetailMetric label={t.backfill} value={page?.denominator.historicalBackfill ?? 0} />
                <DetailMetric label={t.afterActivation} value={page?.denominator.postActivationIntake ?? 0} />
                <DetailMetric label={t.confirmed} value={page?.denominator.typedConfirmed ?? 0} />
                <DetailMetric label={t.ambiguous} value={page?.denominator.ambiguousOrContaminated ?? 0} />
              </dl>
              <div className="mt-3 border-t border-[var(--console-border-soft)] pt-3 text-cafe-secondary">
                <p className="font-semibold text-cafe">{t.rules}</p>
                <p className="mt-1 leading-relaxed">{t.actionRules}</p>
                <p className="mt-1 text-micro leading-relaxed text-cafe-muted">
                  {dutyConfigured ? t.dutyRules : t.noDuty}
                </p>
              </div>
            </div>
          )}
        </ControlPopover>

        {newCount > 0 ? (
          <button
            type="button"
            onClick={onNewest}
            className="h-9 whitespace-nowrap rounded-lg border border-conn-green-ring bg-conn-green-bg px-3 text-xs font-semibold text-conn-green-text"
          >
            {t.newReports(newCount)}
          </button>
        ) : null}
      </fieldset>
    </div>
  );
}

function SummaryMetric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return (
    <div
      className={`flex shrink-0 items-baseline gap-1 whitespace-nowrap ${alert ? 'text-conn-red-text' : 'text-cafe'}`}
      data-testid="paw-feel-summary-metric"
    >
      <dt className="text-micro text-cafe-muted">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: number }) {
  return (
    <>
      <dt className="min-w-0 truncate" title={label}>
        {label}
      </dt>
      <dd className="whitespace-nowrap text-right font-semibold tabular-nums text-cafe">{value}</dd>
    </>
  );
}

function ControlPopover({
  align = 'left',
  icon,
  label,
  popoverKind,
  testId,
  children,
}: {
  align?: 'left' | 'right';
  icon: ReactNode;
  label: string;
  popoverKind: 'menu' | 'dialog';
  testId: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerId = useId();
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative max-w-full" ref={rootRef}>
      <button
        id={triggerId}
        type="button"
        aria-controls={open ? popoverId : undefined}
        aria-expanded={open}
        aria-haspopup={popoverKind}
        data-testid={`${testId}-trigger`}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 max-w-full items-center gap-2 whitespace-nowrap rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 text-xs font-medium text-cafe-secondary shadow-[var(--console-shadow-soft)] transition hover:bg-[var(--console-hover-bg)] hover:text-cafe"
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon open={open} />
      </button>
      {open && popoverKind === 'menu' ? (
        <div
          id={popoverId}
          role="menu"
          aria-labelledby={triggerId}
          data-testid={`${testId}-menu`}
          className={`absolute top-full z-40 mt-2 overflow-hidden rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] shadow-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
      {open && popoverKind === 'dialog' ? (
        <div
          id={popoverId}
          role="dialog"
          aria-labelledby={triggerId}
          data-testid={`${testId}-menu`}
          className={`absolute top-full z-40 mt-2 overflow-hidden rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] shadow-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function MenuOption({
  selected,
  label,
  count,
  onClick,
}: {
  selected: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex w-52 max-w-[calc(100vw-2.5rem)] items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-[var(--console-hover-bg)] ${
        selected ? 'font-semibold text-cafe' : 'text-cafe-secondary'
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-[var(--console-border-strong)]">
        {selected ? <CheckIcon /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? <span className="shrink-0 tabular-nums text-cafe-muted">{count}</span> : null}
    </button>
  );
}
