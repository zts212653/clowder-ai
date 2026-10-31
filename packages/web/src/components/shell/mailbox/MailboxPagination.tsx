import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useShellCopy } from '../shell-copy';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';

export function MailboxPagination({
  read,
  onNextPage,
  onPreviousPage,
}: {
  read: UnifiedAttentionReadV1 | null;
  onNextPage?: () => void;
  onPreviousPage?: () => void;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  if (!read || (!read.page.hasMore && read.page.offset === 0)) return null;
  return (
    <div className="pt-2 text-xs">
      {read.page.hasMore ? (
        <p className="m-0 pb-1.5" style={{ color: 'var(--shell-muted)' }} data-testid="mailbox-has-more">
          {t.more(read.items.length)}
        </p>
      ) : null}
      <nav aria-label={t.pages} className="flex items-center justify-between gap-2">
        <button
          type="button"
          data-testid="mailbox-previous-page"
          disabled={read.page.offset === 0 || !onPreviousPage}
          onClick={onPreviousPage}
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1"
        >
          {t.previous}
        </button>
        <span>{t.page(Math.floor(read.page.offset / read.page.limit) + 1)}</span>
        <button
          type="button"
          data-testid="mailbox-next-page"
          disabled={!read.page.hasMore || !onNextPage}
          onClick={onNextPage}
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1"
        >
          {t.next}
        </button>
      </nav>
    </div>
  );
}
