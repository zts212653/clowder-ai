'use client';

import { useId, useState } from 'react';

type CriticalTextTone = 'critical' | 'warning' | 'info';
type CriticalTextAppearance = 'inline' | 'panel';

const panelToneClasses: Record<CriticalTextTone, string> = {
  critical: 'border-conn-red-ring/40 bg-conn-red-bg/20 text-conn-red-text',
  warning: 'border-[var(--semantic-warning)]/40 bg-[var(--semantic-warning)]/10 text-cafe',
  info: 'border-cafe bg-cafe-surface-elevated text-cafe',
};

const inlineToneClasses: Record<CriticalTextTone, string> = {
  critical: 'text-conn-red-text',
  warning: 'text-conn-amber-text',
  info: 'text-cafe',
};

interface CriticalTextProps {
  summary: string;
  details?: string;
  tone?: CriticalTextTone;
  appearance?: CriticalTextAppearance;
  className?: string;
}

export function CriticalText({
  summary,
  details,
  tone = 'critical',
  appearance = 'inline',
  className = '',
}: CriticalTextProps) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const panel = appearance === 'panel';

  return (
    <section
      data-critical-text-appearance={appearance}
      className={`${panel ? `rounded-xl border px-4 py-3 ${panelToneClasses[tone]}` : `min-w-0 ${inlineToneClasses[tone]}`} ${className}`}
    >
      <p
        className={`whitespace-pre-wrap break-words text-sm ${panel ? 'font-semibold leading-6' : 'font-medium leading-5'}`}
      >
        {summary}
      </p>
      {details && (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            aria-expanded={expanded}
            aria-controls={detailsId}
            className={
              panel
                ? 'mt-2 rounded-md border border-current/30 px-2.5 py-1.5 text-xs font-bold transition-colors hover:bg-[var(--console-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current'
                : 'mt-1 inline-flex rounded px-0.5 py-1 text-xs font-semibold text-cafe-muted transition-colors hover:text-cafe-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent'
            }
          >
            {expanded ? '收起技术详情' : '查看技术详情'}
          </button>
          {expanded && (
            <pre
              id={detailsId}
              className={
                panel
                  ? 'mt-3 max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--console-card-bg)] p-3 font-mono text-xs leading-5 text-cafe-secondary'
                  : 'mt-2 max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words border-l-2 border-current/20 pl-3 font-mono text-xs leading-5 text-cafe-secondary'
              }
            >
              {details}
            </pre>
          )}
        </>
      )}
    </section>
  );
}
