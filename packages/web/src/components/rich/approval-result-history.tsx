import { createContext, type ReactNode, useContext } from 'react';
import { useShellCopy } from '../shell/shell-copy';
import { decisionResultCopy } from './decision-result.shell-copy';

/** Changes only the compact heading. Producer result/actions and their authority remain on the original row. */
export const ApprovalResultHistory = createContext<{
  subject: string;
  proposer: string;
  kind: string;
  time: string;
  details: ReactNode;
  /** Optional actions on the same row as the original, read-only technical disclosure. */
  actions?: ReactNode;
  retry?: () => void;
} | null>(null);

/** Keep the original read-only detail available without turning an expanded history row into a full card. */
export function HistoryTechnicalDetails({ children }: { children: ReactNode }) {
  const history = useContext(ApprovalResultHistory);
  const t = useShellCopy(decisionResultCopy);
  if (!history) return <>{children}</>;
  const details = (
    <details data-testid="handled-technical-details" className="order-1 text-xs text-[var(--shell-muted)]">
      <summary className="shell-focusable cursor-pointer">{t.technical}</summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  );
  return history.actions ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 text-compact" data-testid="handled-actions">
      {history.actions}
      {details}
    </div>
  ) : (
    details
  );
}
