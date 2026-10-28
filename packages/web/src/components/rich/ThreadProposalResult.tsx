import { type ReactNode, useContext, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { ApprovalResultRow, type DecisionResultStatus } from './ApprovalResultRow';
import { ApprovalResultHistory } from './approval-result-history';
import { decisionResultCopy } from './decision-result.shell-copy';
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
  effectFailed = false,
  effectInProgress = false,
  authorizeOpen,
  children,
  onExpandedChange,
  resolveThreadId,
  superseded = false,
  replacementAction,
}: {
  status: DecisionResultStatus;
  decidedAt?: number;
  threadId?: string | null;
  openLocked?: boolean;
  effectUnknown?: boolean;
  effectFailed?: boolean;
  effectInProgress?: boolean;
  authorizeOpen?: () => boolean;
  children: ReactNode;
  onExpandedChange?: (expanded: boolean) => void;
  resolveThreadId?: () => Promise<string | null>;
  superseded?: boolean;
  replacementAction?: ReactNode;
}) {
  const t = useShellCopy(proposalResultCopy);
  const resultCopy = useShellCopy(decisionResultCopy);
  const language = useShellLanguage();
  const history = useContext(ApprovalResultHistory);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const time = history ? null : resultTime(decidedAt, language);
  const label = superseded
    ? t.superseded
    : status === 'approved'
      ? [
          t.approved,
          effectFailed
            ? t.failed
            : effectInProgress
              ? t.inProgress
              : effectUnknown
                ? t.effectUnknown
                : threadId
                  ? t.opened
                  : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : [status === 'rejected' ? t.declined : resultCopy[status], time].filter(Boolean).join(' · ');
  return (
    <div data-testid="thread-proposal-result" style={effectFailed ? { color: 'var(--semantic-warning)' } : undefined}>
      <ApprovalResultRow
        status={status}
        label={label}
        testIdPrefix="proposal-result"
        onExpandedChange={onExpandedChange}
        warning={effectFailed}
        actions={
          superseded ? (
            replacementAction
          ) : status === 'approved' && (threadId || resolveThreadId) ? (
            <>
              <span aria-hidden="true">{' · '}</span>
              {/* A native href would let middle-click/context-menu skip the synchronous continuation guard. */}
              <button
                type="button"
                data-testid="proposal-result-open"
                disabled={openLocked || opening}
                aria-disabled={openLocked || undefined}
                className="shell-focusable shrink-0 text-[var(--shell-body)] hover:underline disabled:opacity-50"
                onClick={async () => {
                  if (openingRef.current) return;
                  if (authorizeOpen && !authorizeOpen()) return;
                  if (threadId) {
                    pushThreadRouteWithHistory(threadId, window);
                    return;
                  }
                  openingRef.current = true;
                  setOpening(true);
                  try {
                    const target = threadId ?? (await resolveThreadId?.());
                    if (target && (!authorizeOpen || authorizeOpen())) pushThreadRouteWithHistory(target, window);
                  } finally {
                    openingRef.current = false;
                    setOpening(false);
                  }
                }}
              >
                {effectFailed ? t.retry : t.open}
              </button>
            </>
          ) : null
        }
      >
        {children}
      </ApprovalResultRow>
    </div>
  );
}
