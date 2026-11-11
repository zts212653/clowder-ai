'use client';
import type { ProfileItem } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { AccountRowMenu } from './AccountRowMenu';
import { accountsCopy } from './accounts.shell-copy';

export function AccountRowActions({
  account,
  busy,
  used,
  memberCount,
  label,
  open,
  canRelogin,
  onAction,
  onRename,
  onRelogin,
  onOpenTerminal,
  onEdit,
  onDelete,
  onExpand,
  expandLabel,
}: {
  account: ProfileItem;
  busy: boolean;
  used: boolean;
  memberCount: number;
  label: string;
  open: boolean;
  canRelogin: boolean;
  onAction: () => void;
  onRename: () => void;
  onRelogin: () => void;
  onOpenTerminal?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onExpand: () => void;
  expandLabel: string;
}) {
  const t = useShellCopy(accountsCopy);
  return (
    <div className="account-row-actions">
      {onOpenTerminal && (
        <button type="button" className="account-button" disabled={busy} onClick={onOpenTerminal}>
          {t.openLoginTerminal}
        </button>
      )}
      {label && (
        <button type="button" className="account-button" disabled={busy} onClick={onAction}>
          {label}
        </button>
      )}
      <AccountRowMenu
        account={account}
        busy={busy}
        used={used}
        memberCount={memberCount}
        canRelogin={canRelogin}
        onRename={onRename}
        onRelogin={onRelogin}
        onEdit={onEdit}
        onDelete={onDelete}
      />
      <button type="button" className="account-expand" aria-label={expandLabel} aria-expanded={open} onClick={onExpand}>
        {open ? '⌃' : '⌄'}
      </button>
    </div>
  );
}
