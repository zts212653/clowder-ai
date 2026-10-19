import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useShellCopy } from '../shell-copy';
import { MailboxActionIcon } from './MailboxActionIcon';
import { MailboxPersonalButton } from './MailboxPersonalButton';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import type { MailboxPersonalActions } from './use-mailbox-personal-preferences';

export function MailboxItemPersonalAction({
  item,
  personal,
}: {
  item: UnifiedAttentionItemV1;
  personal: MailboxPersonalActions;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const restore = personal.mode === 'ignored';
  return (
    <MailboxPersonalButton
      type="button"
      data-testid={restore ? 'mailbox-item-restore' : 'mailbox-item-ignore'}
      refusal={personal.refusal(item)}
      label={restore ? t.restore : t.ignore}
      onClick={() => item.preferenceCoordinate && void personal.change(item, restore)}
      className="shell-nav-row shell-focusable inline-flex items-center gap-1.5 flex-none rounded-lg px-3 py-1.5 text-sm disabled:opacity-50"
      style={{ border: '1px solid var(--shell-hairline)' }}
    >
      <MailboxActionIcon restore={restore} />
      {restore ? t.restore : t.ignore}
    </MailboxPersonalButton>
  );
}
