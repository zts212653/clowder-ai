'use client';

import { type ReactNode, useState } from 'react';
import { ExpandableProse } from './content-overflow';

export interface ApprovalCardDetails {
  label: string;
  expandedLabel?: string;
  content: ReactNode;
  testId?: string;
}

interface ApprovalCardShellProps {
  testId: string;
  header?: ReactNode;
  title: string;
  titleLines?: 2 | 3 | 4;
  titleTestId?: string;
  context?: ReactNode;
  highlight?: ReactNode;
  actions?: ReactNode;
  details?: ApprovalCardDetails;
  className?: string;
}

/** F305 shared reading order for pending and settled approval records. */
export function ApprovalCardShell({
  testId,
  header,
  title,
  titleLines = 3,
  titleTestId,
  context,
  highlight,
  actions,
  details,
  className = '',
}: ApprovalCardShellProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <article
      className={`overflow-hidden rounded-xl border border-cafe bg-cafe-surface shadow-sm ${className}`.trim()}
      data-approval-card-shell="true"
      data-testid={testId}
    >
      <div className="space-y-3 p-3">
        {header && <header>{header}</header>}

        <div className="space-y-1.5">
          <div data-testid={titleTestId}>
            <ExpandableProse
              as="h3"
              text={title}
              lines={titleLines}
              contentClassName="text-sm font-semibold leading-snug text-cafe"
            />
          </div>
          {context}
        </div>

        {highlight}
        {actions}

        {details && (
          <details
            className="border-t border-cafe-subtle pt-2 text-micro text-cafe-secondary"
            data-testid={details.testId}
            onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer font-medium text-cafe-secondary">
              {detailsOpen ? (details.expandedLabel ?? details.label) : details.label}
            </summary>
            <div className="mt-2">{details.content}</div>
          </details>
        )}
      </div>
    </article>
  );
}
