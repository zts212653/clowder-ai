'use client';

import type { PawFeelReviewBundle } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { usePawFeelCopy, usePawFeelLanguage } from '../paw-feel/paw-feel.shell-copy';
import { pawFeelContinuationLabel } from '../paw-feel/paw-feel-issue-presentation';
import { PawFeelInboxRow } from './PawFeelInboxRow';

const RESPONSIBILITY_LABELS: Record<PawFeelReviewBundle['responsibility']['state'], string> = {
  unreviewed: 'unreviewed',
  bound_in_repair: 'bound-in-repair',
  signature_waiting: 'signature-waiting',
  blocked: 'blocked',
  terminal: 'terminal',
};

export function PawFeelInboxBundle({ bundle }: { bundle: PawFeelReviewBundle }) {
  const t = usePawFeelCopy();
  const language = usePawFeelLanguage();
  const BASIS_LABELS = t.basis;
  const STATE_LABELS: Record<string, string> = t.states;
  const [expanded, setExpanded] = useState(false);
  const representative = bundle.members[0];
  const stateSummary = useMemo(
    () =>
      Object.entries(bundle.stateCounts)
        .map(([state, count]) => `${STATE_LABELS[state] ?? state} ${count}`)
        .join(' · '),
    [bundle.stateCounts, STATE_LABELS],
  );

  return (
    <article
      className="min-w-0 px-3 py-3 sm:px-4"
      data-testid="paw-feel-inbox-bundle"
      data-basis={bundle.basis}
      data-responsibility={bundle.responsibility.state}
      data-resolution={bundle.issue.resolution}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-cafe">
            <span>
              {BASIS_LABELS[bundle.basis]} · {t.reportCount(bundle.rawSignalCount)}
            </span>
            <span
              className="rounded-full border border-current px-1.5 py-0.5 font-mono text-micro text-cafe-secondary"
              data-testid="paw-feel-responsibility-state"
            >
              {RESPONSIBILITY_LABELS[bundle.responsibility.state]}
              {!bundle.responsibility.validExit ? ` · ${t.noExit}` : ''}
            </span>
            <span className="rounded-full border border-current px-1.5 py-0.5 text-micro text-cafe-secondary">
              {bundle.issue.resolution === 'resolved' ? t.issueResolved : t.issueOpen} ·{' '}
              {pawFeelContinuationLabel(bundle.issue.continuation.kind, language)}
            </span>
          </div>
          <div className="mt-1 truncate text-micro text-cafe-muted" title={stateSummary}>
            {stateSummary}
          </div>
        </div>
        {representative?.source.availability === 'available' ? (
          <a
            className="block min-w-0 max-w-full truncate text-xs font-medium text-cafe-secondary hover:underline sm:max-w-[52%] sm:text-right"
            href={representative.source.sourceHref}
            title={representative.source.preview}
          >
            {representative.source.preview}
          </a>
        ) : (
          <span className="text-micro text-conn-amber-text">{t.sourceUnavailable}</span>
        )}
      </div>

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex items-center gap-1 text-xs font-medium text-cafe-secondary transition hover:text-cafe"
          aria-expanded={expanded}
        >
          {expanded ? t.collapseReports : t.expandReports(bundle.rawSignalCount)}
          <ChevronIcon open={expanded} />
        </button>
      </div>

      {expanded ? (
        <div className="mt-3 space-y-2">
          {bundle.members.map((item) => (
            <PawFeelInboxRow key={item.disposition.signalId} item={item} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
