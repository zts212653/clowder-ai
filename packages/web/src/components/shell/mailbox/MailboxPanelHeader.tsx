import { useShellCopy } from '../shell-copy';
import { handledHistoryCopy } from './handled-history.shell-copy';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import type { MailboxSection } from './mailbox-navigation';

export function MailboxPanelHeader({
  section,
  total,
  onClose,
  onBack,
  onOpenSchedule,
}: {
  section: MailboxSection;
  total: number | null;
  onClose: () => void;
  onBack: () => void;
  onOpenSchedule?: () => void;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const history = useShellCopy(handledHistoryCopy);
  const title = ['history', 'records', 'ignored'].includes(section)
    ? history.title
    : section === 'tools'
      ? t.approvalTools
      : t.title;
  return (
    <header className="flex-none px-[22px] pb-3 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-base font-semibold" data-testid="mailbox-title">
          {title}
        </h2>
        <button
          type="button"
          data-testid="mailbox-close"
          aria-label={t.close}
          onClick={onClose}
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-base leading-none"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {section === 'pending' ? (
        <nav
          aria-label={t.sections}
          className="mt-3 flex items-center gap-1 rounded-lg p-1"
          style={{ background: 'var(--shell-frame)' }}
        >
          <button
            type="button"
            aria-current="page"
            onClick={onBack}
            id="mailbox-tab-needs-me"
            className="shell-focusable flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium"
            style={{
              background: 'var(--shell-selected)',
              borderColor: 'var(--shell-hairline-strong)',
              color: 'var(--shell-ink)',
            }}
            data-testid="mailbox-tab-needs-me"
          >
            {t.needsMe}
            {total !== null ? (
              <span
                className="rounded-full px-[7px] text-label font-semibold"
                data-testid="mailbox-tab-count"
                style={{ background: 'var(--shell-paper)', color: 'var(--shell-ink)' }}
              >
                {total}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={onOpenSchedule}
            disabled={!onOpenSchedule}
            data-testid="mailbox-tab-schedule"
            className="shell-nav-row shell-focusable min-w-0 flex-1 rounded-md border border-transparent px-3 py-1.5 text-sm disabled:opacity-50"
            style={{ color: 'var(--shell-muted)' }}
          >
            {t.schedule}
          </button>
        </nav>
      ) : section === 'history' || section === 'ignored' ? (
        <button
          type="button"
          onClick={onBack}
          data-testid="mailbox-handled-back"
          className="shell-nav-row shell-focusable mt-3 rounded-lg px-2 py-1 text-xs"
        >
          ‹ {t.back}
        </button>
      ) : null}
    </header>
  );
}
