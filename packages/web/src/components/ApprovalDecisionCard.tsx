'use client';

import type { ReactNode } from 'react';
import { ExpandableProse } from './content-overflow';

export interface ApprovalDecisionDetails {
  label: string;
  content: ReactNode;
  testId?: string;
}

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
    <article className="overflow-hidden rounded-xl border border-cafe bg-cafe-surface shadow-sm" data-testid={testId}>
      <div className="space-y-3 p-3">
        {header && <header>{header}</header>}

        <div className="space-y-1.5">
          <ExpandableProse
            as="h3"
            text={title}
            lines={3}
            contentClassName="text-sm font-semibold leading-snug text-cafe"
          />
          {actionReason && (
            <div className="text-micro leading-relaxed text-cafe-secondary" data-testid="approval-action-reason">
              {actionReason}
            </div>
          )}
        </div>

        {recommendation && (
          <section
            className="rounded-lg border border-cafe-subtle bg-cafe-surface-elevated p-3"
            data-testid="approval-recommendation"
          >
            {recommendation}
          </section>
        )}

        <div className="border-t border-cafe-subtle pt-2" data-testid="approval-current-decision">
          {currentDecision}
        </div>

        {details && (
          <details
            className="border-t border-cafe-subtle pt-2 text-micro text-cafe-secondary"
            data-testid={details.testId}
          >
            <summary className="cursor-pointer font-medium text-cafe-secondary">{details.label}</summary>
            <div className="mt-2">{details.content}</div>
          </details>
        )}
      </div>
    </article>
  );
}
