import type { VideoProjectDecision } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useScreeningCopy } from './screening.shell-copy';

/** Current-project bookkeeping stays distinct from the frozen film being viewed. */
export function ProjectReviewHeader({
  title,
  counts,
  decisionCount,
  children,
  onDecisions,
  onMark,
}: {
  title: string;
  counts: { hasRecords: boolean; reviewed: number };
  decisionCount: number;
  children?: ReactNode;
  onDecisions?: () => void;
  onMark?: () => void;
}) {
  const t = useScreeningCopy();
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-cafe-subtle bg-[var(--shell-paper,var(--cafe-surface))] px-4 py-2">
      <h1 className="max-w-28 truncate text-sm font-semibold" title={title}>
        {title}
      </h1>
      {children}
      <span className="text-xs text-cafe-secondary">
        {counts.hasRecords ? t.reviewed(counts.reviewed) : t.noReview}
      </span>
      {decisionCount ? (
        <button type="button" className="text-xs text-cafe-secondary underline" onClick={onDecisions}>
          {t.decisions(decisionCount)}
        </button>
      ) : null}
      {onMark && (
        <button
          type="button"
          onClick={onMark}
          className="ml-auto rounded-lg bg-cafe-accent px-3 py-1.5 text-sm font-semibold text-white"
        >
          ⚑ {t.mark} <kbd className="ml-1 text-xs">M</kbd>
        </button>
      )}
    </header>
  );
}
export function CurrentProjectDecisions({ decisions }: { decisions: VideoProjectDecision[] }) {
  if (!decisions.length) return null;
  return (
    <aside
      aria-label="当前待决定"
      className="mt-5 rounded-xl border border-cafe-subtle bg-[var(--shell-paper,var(--cafe-surface))] p-4"
    >
      <h2 className="text-sm font-semibold">待决定</h2>
      <ul className="mt-3 space-y-3">
        {decisions.map((decision) => (
          <li key={decision.id} className="text-sm">
            <p>{decision.question}</p>
            <p className="mt-1 text-xs text-cafe-secondary">
              {decision.options?.map((option) => option.text).join(' / ')}
            </p>
          </li>
        ))}
      </ul>
    </aside>
  );
}
