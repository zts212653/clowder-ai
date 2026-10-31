'use client';

import { useState } from 'react';

function serializeDetail(detail: Record<string, unknown>): string {
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return Object.entries(detail)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join('\n');
  }
}

export function ApprovalTechnicalDetailContent({ detail }: { detail: Record<string, unknown> }) {
  return (
    <pre className="max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--console-card-bg)] p-3 font-mono text-xs leading-5 text-cafe-secondary">
      {serializeDetail(detail)}
    </pre>
  );
}

export function ApprovalTechnicalDetails({
  detail,
  testId = 'approval-technical-details',
}: {
  detail: Record<string, unknown>;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  if (Object.keys(detail).length === 0) return null;

  return (
    <details
      className="mt-1 text-micro text-cafe-secondary"
      data-testid={testId}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="w-fit cursor-pointer rounded-md border border-[var(--cafe-border)] px-2 py-1 font-medium transition-colors hover:bg-[var(--cafe-muted)]">
        {open ? '收起技术详情' : '查看技术详情'}
      </summary>
      <div className="mt-2">
        <ApprovalTechnicalDetailContent detail={detail} />
      </div>
    </details>
  );
}
