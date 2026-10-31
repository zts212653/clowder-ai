'use client';
import { createContext, type ReactNode, useContext, useId, useState } from 'react';
import { ApprovalReceiptPresentation, receiptOutcome } from '../approval-receipt/receipt-presentation';
import { useShellCopy } from '../shell/shell-copy';
import { ApprovalResultHistory } from './approval-result-history';
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
  warning = false,
}: {
  status: DecisionResultStatus;
  label: string;
  actions?: ReactNode;
  children: ReactNode;
  testIdPrefix?: string;
  onExpandedChange?: (expanded: boolean) => void;
  warning?: boolean;
}) {
  const t = useShellCopy(decisionResultCopy);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const insideDetails = useContext(ResultDetailsContext);
  const receipt = useContext(ApprovalReceiptPresentation);
  const history = useContext(ApprovalResultHistory);
  if (receipt) {
    const outcome = receiptOutcome(label, receipt.decisionWord, receipt.time);
    return (
      <div
        data-testid="decision-result-row"
        data-presentation="chat-receipt"
        className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]"
        style={warning ? { color: 'var(--semantic-warning)' } : undefined}
      >
        <span
          aria-hidden="true"
          data-testid={`${testIdPrefix}-dot`}
          data-status={receipt.status}
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{
            background: warning
              ? 'var(--semantic-warning)'
              : receipt.status === 'approved'
                ? 'var(--semantic-success)'
                : 'var(--semantic-critical)',
          }}
        />
        {receipt.lead}
        {outcome ? (
          <>
            <span aria-hidden="true">·</span>
            <span data-testid={`${testIdPrefix}-label`}>{outcome}</span>
          </>
        ) : null}
        {actions}
        {receipt.suffix}
      </div>
    );
  }
  if (history && !insideDetails) {
    return (
      <div
        data-testid="decision-result-row"
        className="min-w-0 text-sm"
        style={warning ? { color: 'var(--semantic-warning)' } : undefined}
      >
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={id}
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
              className="mr-2 inline-block h-2 w-2 rounded-full"
              style={{
                background: warning
                  ? 'var(--semantic-warning)'
                  : status === 'approved'
                    ? 'var(--semantic-success)'
                    : status === 'rejected'
                      ? 'var(--semantic-critical)'
                      : 'var(--shell-muted)',
              }}
            />
            <span data-testid={`${testIdPrefix}-label`}>{label}</span>
          </button>
          {actions}
          {warning && !actions && history.retry ? (
            <button type="button" className="shell-focusable hover:underline" onClick={history.retry}>
              {t.retry}
            </button>
          ) : null}
          <span className="rounded px-1 text-xs text-[var(--shell-muted)]" style={{ background: 'var(--shell-frame)' }}>
            {history.kind}
          </span>
          <span className="ml-auto text-xs text-[var(--shell-muted)]">{history.time}</span>
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            setExpanded(!expanded);
            onExpandedChange?.(!expanded);
          }}
          className="shell-focusable mt-1 block w-full break-words text-left text-[var(--shell-body)] hover:underline"
        >
          {history.subject} · {history.proposer}
        </button>
        {expanded ? (
          <div
            id={id}
            data-testid={`${testIdPrefix}-details`}
            className="mt-3 min-w-0 space-y-3 rounded-xl border p-3"
            style={{ borderColor: 'var(--shell-hairline)', background: 'var(--shell-paper)' }}
          >
            {history.details}
            <ResultDetailsContext.Provider value>{children}</ResultDetailsContext.Provider>
          </div>
        ) : null}
      </div>
    );
  }
  if (insideDetails) return <>{children}</>;
  return (
    <div
      data-testid="decision-result-row"
      className="min-w-0 text-sm"
      style={warning ? { color: 'var(--semantic-warning)' } : undefined}
    >
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
              background: warning
                ? 'var(--semantic-warning)'
                : status === 'approved'
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
