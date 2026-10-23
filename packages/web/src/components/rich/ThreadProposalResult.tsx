import { type ReactNode, useId, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { proposalResultCopy } from './proposal-result.shell-copy';

function resultTime(value: number | undefined, language: string): string | null {
  if (value === undefined || !Number.isFinite(value) || Number.isNaN(new Date(value).getTime())) return null;
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}

/** Presentation of an already-proven decision. The caller retains ownership of reads and navigation authority. */
export function ThreadProposalResult({
  status,
  decidedAt,
  threadId,
  openLocked = false,
  effectUnknown = false,
  authorizeOpen,
  children,
}: {
  status: 'approved' | 'rejected';
  decidedAt?: number;
  threadId?: string | null;
  openLocked?: boolean;
  effectUnknown?: boolean;
  authorizeOpen?: () => boolean;
  children: ReactNode;
}) {
  const t = useShellCopy(proposalResultCopy);
  const language = useShellLanguage();
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const time = resultTime(decidedAt, language);
  const label =
    status === 'approved'
      ? [t.approved, effectUnknown ? t.effectUnknown : threadId ? t.opened : null].filter(Boolean).join(' · ')
      : [t.declined, time].filter(Boolean).join(' · ');
  return (
    <div data-testid="thread-proposal-result" className="min-w-0 text-sm">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          title={expanded ? t.collapse : t.details}
          onClick={() => setExpanded((value) => !value)}
          className="shell-focusable flex min-w-0 items-center gap-2 text-left hover:underline"
        >
          <span
            aria-hidden="true"
            data-testid="proposal-result-dot"
            data-status={status}
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: status === 'approved' ? 'var(--semantic-success)' : 'var(--semantic-critical)' }}
          />
          <span data-testid="proposal-result-label" className="truncate" title={label}>
            {label}
          </span>
        </button>
        {status === 'approved' && threadId ? (
          <>
            <span aria-hidden="true">·</span>
            {/* A native href would let middle-click/context-menu skip the synchronous continuation guard. */}
            <button
              type="button"
              data-testid="proposal-result-open"
              disabled={openLocked}
              aria-disabled={openLocked || undefined}
              className="shell-focusable shrink-0 text-[var(--shell-body)] hover:underline disabled:opacity-50"
              onClick={() => {
                if (authorizeOpen && !authorizeOpen()) return;
                pushThreadRouteWithHistory(threadId, window);
              }}
            >
              {t.open}
            </button>
          </>
        ) : null}
      </div>
      {expanded ? (
        <div id={id} data-testid="proposal-result-details" className="mt-3 space-y-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}
