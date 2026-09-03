'use client';

import type { ReactNode } from 'react';
import { type ApprovalCardDetails, ApprovalCardShell } from './ApprovalCardShell';

export type ApprovalDecisionDetails = ApprovalCardDetails;

export interface ApprovalDecisionCardProps {
  testId: string;
  header?: ReactNode;
  title: string;
  actionReason?: ReactNode;
  recommendation?: ReactNode;
  currentDecision: ReactNode;
  details?: ApprovalDecisionDetails;
}

/**
 * Shared presentation order for user decisions.
 *
 * Business adapters own state, actions, errors, and persistence. This component
 * only gives those values a stable visual hierarchy.
 */
export function ApprovalDecisionCard({
  testId,
  header,
  title,
  actionReason,
  recommendation,
  currentDecision,
  details,
}: ApprovalDecisionCardProps) {
  return (
    <ApprovalCardShell
      testId={testId}
      header={header}
      title={title}
      context={
        actionReason ? (
          <div className="text-micro leading-relaxed text-cafe-secondary" data-testid="approval-action-reason">
            {actionReason}
          </div>
        ) : undefined
      }
      highlight={
        recommendation ? (
          <section
            className="rounded-lg border border-cafe-subtle bg-cafe-surface-elevated p-3"
            data-testid="approval-recommendation"
          >
            {recommendation}
          </section>
        ) : undefined
      }
      actions={
        <div className="border-t border-cafe-subtle pt-2" data-testid="approval-current-decision">
          {currentDecision}
        </div>
      }
      details={details}
    />
  );
}
