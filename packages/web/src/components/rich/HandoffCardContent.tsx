import { MarkdownContent } from '@/components/MarkdownContent';
import type { RichCardBlock } from '@/stores/chat-types';
import { originalApprovalCopy } from '../shell/mailbox/original-approval.shell-copy';
import { useShellCopy } from '../shell/shell-copy';

export function HandoffCardContent({ fields }: { fields: NonNullable<RichCardBlock['fields']> }) {
  const t = useShellCopy(originalApprovalCopy);
  const session = fields.find((field) => field.label === '封印 session');
  const worktree = fields.find((field) => field.label === 'worktree');
  const commits = fields.find((field) => field.label === 'commits');
  const content = fields.filter((field) => !['封印 session', 'worktree', 'commits'].includes(field.label));
  const labels: Record<string, string> = { 已完成: t.done, 下一步: t.next, gotchas: t.gotchas };
  return (
    <div className="mt-3 space-y-2 text-xs">
      <div className="flex flex-wrap gap-2 text-[var(--shell-muted)]">
        {session ? <span>{t.currentSession}</span> : null}
        {worktree ? <span className="break-all">worktree: {worktree.value}</span> : null}
        {commits ? <span>{t.commits(commits.value.split(', ').length)}</span> : null}
      </div>
      {content.length ? (
        <details
          data-testid="original-approval-long-content"
          className="rounded-lg border border-[var(--shell-hairline)] p-2"
        >
          <summary className="shell-focusable cursor-pointer font-medium">{t.handoffDetails}</summary>
          <div
            role="region"
            aria-label={t.handoffDetails}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: bounded original text supports keyboard scrolling
            tabIndex={0}
            className="mt-2 max-h-64 overflow-y-auto break-words space-y-3"
          >
            {content.map((field) => (
              <section key={field.label}>
                <h4 className="font-semibold">{labels[field.label] ?? field.label}</h4>
                <MarkdownContent content={field.value} className="!text-xs" disableCommandPrefix />
              </section>
            ))}
          </div>
        </details>
      ) : null}
      {session || commits ? (
        <details className="text-[var(--shell-muted)]">
          <summary className="shell-focusable cursor-pointer">{t.technical}</summary>
          <div className="mt-1 break-all">
            {[session, commits].map((field) =>
              field ? (
                <p key={field.label}>
                  {field.label}: {field.value}
                </p>
              ) : null,
            )}
          </div>
        </details>
      ) : null}
    </div>
  );
}
