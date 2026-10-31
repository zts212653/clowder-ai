import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useShellCopy } from '../shell-copy';
import type { UnifiedAttentionView } from '../use-unified-attention';
import { MailboxPeriodFilter } from './MailboxPeriodFilter';
import { MailboxPersonalButton } from './MailboxPersonalButton';
import { MentionHandlingConfirmation } from './MentionHandlingConfirmation';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import type { useMailboxPersonalPreferences } from './use-mailbox-personal-preferences';
import { usePersonalMentionBatch } from './use-personal-mention-batch';

/** One named full-set ignore action. Canonical handling history and recovery remain distinct. */
export function MailboxMentionControls({
  read,
  view,
  personal,
  count,
}: {
  read: UnifiedAttentionReadV1 | null;
  view: UnifiedAttentionView;
  personal: ReturnType<typeof useMailboxPersonalPreferences>;
  count: string;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const period = read?.mentionPeriod === 'today' || read?.mentionPeriod === 'earlier' ? read.mentionPeriod : 'week';
  const batch = usePersonalMentionBatch(read, view, personal);
  const labels = { today: t.today, week: t.week, earlier: t.earlierPeriod, all: t.allTime };
  return (
    <div className="mb-3 flex flex-col gap-2 text-xs" data-testid="mailbox-mention-controls">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          {t.mentions}{' '}
          <span className="font-normal" style={{ color: 'var(--shell-muted)' }}>
            {count}
          </span>
        </h3>
        <div className="flex flex-none items-center gap-1">
          <MailboxPeriodFilter read={read} view={view} busy={batch.busy} compact />
          <MailboxPersonalButton
            type="button"
            data-testid="mailbox-mentions-ignore-all"
            refusal={batch.busy ? 'refreshing' : personal.batchRefusal}
            label={t.ignoreAllShort}
            className="shell-nav-row shell-focusable rounded-lg border border-[var(--shell-hairline-strong)] px-2 py-1 disabled:opacity-50"
            aria-label={t.ignoreAll(labels[period])}
            onClick={() => void batch.prepare(period)}
          >
            {t.ignoreAllShort}
          </MailboxPersonalButton>
        </div>
      </div>
      {batch.notice ? (
        <p role="status" className="m-0" data-testid="mailbox-bulk-ignore-notice">
          {batch.notice === 'empty'
            ? t.bulkEmpty
            : batch.notice === 'changed'
              ? t.preferenceConflict
              : t.preferenceUnavailable}
        </p>
      ) : null}
      {batch.snapshot ? (
        <MentionHandlingConfirmation
          count={batch.snapshot.requests.length}
          scope={batch.snapshot.period}
          counts={batch.snapshot.counts}
          busy={batch.busy}
          onConfirm={() => void batch.confirm()}
          onCancel={batch.cancel}
          personal={{
            title: t.ignoreDialog,
            description: t.ignoreExplanation(batch.snapshot.requests.length, labels[batch.snapshot.period]),
            confirm: t.ignoreConfirm(batch.snapshot.requests.length),
            cancel: t.cancel,
          }}
        />
      ) : null}
    </div>
  );
}
