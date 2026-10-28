import type { ReactNode } from 'react';
import type { Terminal } from '../shell/mailbox/approval-reconcile';
import { ApprovalResultRow } from './ApprovalResultRow';

/** A verified canonical terminal is required; absence, request completion and unknown reads do not enter here. */
export function ReconciledApprovalResult({
  terminal,
  line,
  children,
  actions,
  onExpandedChange,
  effectFailed = false,
}: {
  terminal: Terminal;
  line: string;
  children: ReactNode;
  actions?: ReactNode;
  onExpandedChange?: (expanded: boolean) => void;
  effectFailed?: boolean;
}) {
  return (
    <ApprovalResultRow
      status={
        terminal.resolution === 'accepted'
          ? 'approved'
          : terminal.resolution === 'rejected'
            ? 'rejected'
            : (terminal.closedReason ?? 'closed')
      }
      label={line}
      actions={actions}
      onExpandedChange={onExpandedChange}
      warning={effectFailed}
    >
      {children}
    </ApprovalResultRow>
  );
}
