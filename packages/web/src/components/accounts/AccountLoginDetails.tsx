'use client';
import type { ProfileItem } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { accountsCopy } from './accounts.shell-copy';

export function AccountLoginDetails({ account }: { account: ProfileItem }) {
  const t = useShellCopy(accountsCopy);
  if (!account.codex && !account.nativeLogin) return null;
  const workspaceId = account.codex?.identity?.workspaceId ?? account.nativeLogin?.identity?.workspaceId;
  return (
    <details>
      <summary>{t.loginDetails}</summary>
      <p>
        {t.loginDirectory}: {account.codex?.credentialHome ?? account.nativeLogin?.home}
      </p>
      {workspaceId && (
        <p>
          {t.workspaceId}: {workspaceId}
        </p>
      )}
    </details>
  );
}
