import { openMailbox } from './mailbox-navigation';

/** Passive compatibility destination: restoring a Workspace page must never open a global panel. */
export function MailboxApprovalEntry({ proposalId }: { proposalId: string | null }) {
  return (
    <button
      type="button"
      className="shell-nav-row shell-focusable rounded-lg px-3 py-2 text-sm"
      onClick={() => openMailbox({ section: 'pending', proposalId })}
    >
      在待办中打开
    </button>
  );
}
