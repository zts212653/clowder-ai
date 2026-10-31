import { useEffect } from 'react';
import { useShellCopy } from '../shell-copy';
import { MailboxPersonalButton } from './MailboxPersonalButton';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import type { useMailboxPersonalPreferences } from './use-mailbox-personal-preferences';

export function MailboxPersonalNotice({ personal }: { personal: ReturnType<typeof useMailboxPersonalPreferences> }) {
  const t = useShellCopy(mailboxEntryCopy);
  // Only the recent UI receipt expires; persistent ignored records remain reachable in the ignored view.
  useEffect(() => {
    if (!personal.undo) return;
    const timer = window.setTimeout(personal.dismissUndo, 12000);
    return () => window.clearTimeout(timer);
  }, [personal.undo, personal.dismissUndo]);
  return (
    <>
      {personal.error ? (
        <p role="status" data-testid="mailbox-personal-notice" className="text-xs">
          {personal.error === 'conflict' ? t.preferenceConflict : t.preferenceUnavailable}
        </p>
      ) : null}
      {personal.undo ? (
        <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span>{t.undoNotice}</span>
          <MailboxPersonalButton
            type="button"
            data-testid="mailbox-personal-undo"
            refusal={personal.undoRefusal}
            label={t.undo}
            className="shell-nav-row shell-focusable rounded px-2 py-1"
            onClick={() => void personal.undoLast()}
          >
            {t.undo}
          </MailboxPersonalButton>
          <button
            type="button"
            aria-label={t.dismiss}
            className="shell-nav-row shell-focusable rounded px-2 py-1"
            data-testid="mailbox-personal-dismiss-undo"
            onClick={personal.dismissUndo}
          >
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}
