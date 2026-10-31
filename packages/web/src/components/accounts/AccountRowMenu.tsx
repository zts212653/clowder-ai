'use client';
import type { ProfileItem } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { accountDisplayName } from './account-directory-view';
import { accountsCopy } from './accounts.shell-copy';

export function AccountRowMenu({
  account,
  busy,
  used,
  memberCount,
  canRelogin,
  onRename,
  onRelogin,
  onEdit,
  onDelete,
}: {
  account: ProfileItem;
  busy: boolean;
  used: boolean;
  memberCount: number;
  canRelogin: boolean;
  onRename: () => void;
  onRelogin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useShellCopy(accountsCopy);
  const native = account.builtin && account.authType === 'oauth';
  return (
    <details className="account-menu">
      <summary aria-label={t.more(accountDisplayName(account, t))}>⋯</summary>
      <div>
        {native ? (
          <p>{t.nativeNotice}</p>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={onRename}>
              {t.rename}
            </button>
            {account.codex && (
              <button type="button" disabled={busy || !canRelogin} onClick={onRelogin}>
                {t.loginAgain}
              </button>
            )}
            {(account.authType === 'api_key' || account.claude) && (
              <button type="button" disabled={busy} onClick={onEdit}>
                {account.claude ? t.replaceToken : t.edit}
              </button>
            )}
            <button type="button" disabled={busy || used || memberCount > 0} onClick={onDelete}>
              {t.delete}
            </button>
            {memberCount > 0 && <small>{t.boundDelete(memberCount)}</small>}
            {used && !memberCount && <small>{t.usedDelete}</small>}
          </>
        )}
      </div>
    </details>
  );
}
