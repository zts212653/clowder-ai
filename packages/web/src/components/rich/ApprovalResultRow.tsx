'use client';
import { createContext, type ReactNode, useContext, useId, useState } from 'react';
import { useShellCopy } from '../shell/shell-copy';
import { decisionResultCopy } from './decision-result.shell-copy';

export type DecisionResultStatus = 'approved' | 'rejected' | 'expired' | 'withdrawn' | 'closed';
const ResultDetailsContext = createContext(false);

/** Pure presentation of an already-proven result. Callers keep all read/write/navigation authority. */
export function ApprovalResultRow({
  status,
  label,
  actions,
  children,
  testIdPrefix = 'decision-result',
  onExpandedChange,
}: {
  status: DecisionResultStatus;
  label: string;
  actions?: ReactNode;
  children: ReactNode;
  testIdPrefix?: string;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const t = useShellCopy(decisionResultCopy);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const insideDetails = useContext(ResultDetailsContext);
  if (insideDetails) return <>{children}</>;
  return (
    <div data-testid="decision-result-row" className="min-w-0 text-sm">
      <div className="min-w-0">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          title={expanded ? t.collapse : t.details}
          onClick={() => {
            setExpanded(!expanded);
            onExpandedChange?.(!expanded);
          }}
          className="shell-focusable max-w-full text-left leading-relaxed hover:underline"
        >
          <span
            aria-hidden="true"
            data-testid={`${testIdPrefix}-dot`}
            data-status={status}
            className="mr-2 inline-block h-2 w-2 shrink-0 rounded-full align-middle"
            style={{
              background:
                status === 'approved'
                  ? 'var(--semantic-success)'
                  : status === 'rejected'
                    ? 'var(--semantic-critical)'
                    : 'var(--shell-muted)',
            }}
          />
          <span
            data-testid={`${testIdPrefix}-label`}
            className="whitespace-normal break-words [overflow-wrap:anywhere]"
            title={label}
          >
            {label}
          </span>
          {!actions ? (
            <span className="ml-1.5 whitespace-nowrap text-[var(--shell-body)]">{expanded ? t.collapse : t.open}</span>
          ) : null}
        </button>
        {actions}
      </div>
      {expanded ? (
        <div id={id} data-testid={`${testIdPrefix}-details`} className="mt-3 min-w-0 space-y-3">
          <ResultDetailsContext.Provider value>{children}</ResultDetailsContext.Provider>
        </div>
      ) : null}
    </div>
  );
}
