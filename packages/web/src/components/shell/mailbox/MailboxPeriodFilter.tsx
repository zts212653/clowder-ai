import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useShellCopy } from '../shell-copy';
import type { UnifiedAttentionView } from '../use-unified-attention';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';

/** Uses the original server period on visible and ignored views; dates never narrow the decision badge. */
export function MailboxPeriodFilter({
  read,
  view,
  busy = false,
  compact = false,
}: {
  read: UnifiedAttentionReadV1 | null;
  view: UnifiedAttentionView;
  busy?: boolean;
  compact?: boolean;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const period = read?.mentionPeriod === 'recent' ? 'week' : (read?.mentionPeriod ?? 'week');
  if (compact) {
    return (
      <select
        aria-label={t.periods}
        value={period}
        disabled={busy || !read}
        className="shell-focusable min-w-0 rounded px-1 py-1 text-xs disabled:opacity-50"
        style={{ background: 'transparent', color: 'var(--shell-body)' }}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'today' || value === 'week' || value === 'earlier') view.setMentionPeriod?.(value);
        }}
      >
        <option value="today">{t.today}</option>
        <option value="week">{t.week}</option>
        <option value="earlier">{t.earlierPeriod}</option>
      </select>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div role="group" aria-label={t.periods} className="flex flex-wrap gap-1">
        {(['today', 'week', 'earlier'] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`mailbox-period-${value}`}
            aria-pressed={value === period}
            disabled={busy || !read}
            className="shell-nav-row shell-focusable rounded-lg px-2 py-1 disabled:opacity-50"
            style={{ background: value === period ? 'var(--shell-selected)' : undefined }}
            onClick={() => view.setMentionPeriod?.(value)}
          >
            {value === 'today' ? t.today : value === 'week' ? t.week : t.earlierPeriod}
          </button>
        ))}
        {period === 'week' ? (
          <details className="text-xs" style={{ color: 'var(--shell-muted)' }}>
            <summary className="shell-focusable cursor-pointer">{t.periodHelp}</summary>
            <p className="m-0 mt-1">{t.weekHelp}</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}
