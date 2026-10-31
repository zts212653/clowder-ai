'use client';
import { builtinAccountIdForClient, type ClientId } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { AppTooltip } from '../AppTooltip';
import { accountDisplayName } from '../accounts/account-directory-view';
import { accountsCopy } from '../accounts/accounts.shell-copy';
import type { ProfileItem } from '../hub-accounts.types';
import { useShellCopy } from '../shell/shell-copy';
import { useMemberText } from './editor-presentation';

/** Read the original binding and name; selection and login remain in the account domain. */
type AccountNameProps = { cat: CatData; accounts: ProfileItem[] };
export function useMemberAccountLabel({ cat, accounts }: AccountNameProps) {
  const t = useMemberText();
  const copy = useShellCopy(accountsCopy);
  if (cat.id === 'gpt-pro') return t('云端');
  const accountRef = cat.accountRef ?? (cat.cli ? builtinAccountIdForClient(cat.clientId as ClientId) : undefined);
  const account = accounts.find((profile) => profile.id === accountRef);
  if (!account) return accountRef ?? t('认证未确认');
  const name = accountDisplayName(account, copy);
  const duplicate = accounts.some((other) => other.id !== account.id && accountDisplayName(other, copy) === name);
  const identity = account.codex?.identity;
  return [
    name,
    duplicate &&
      (identity ? `${identity.email ?? account.id} · ${copy.workspaceId} ${identity.workspaceId}` : account.id),
    cat.accountBindingMode === 'override' && copy.override,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function MemberAccountName({ cat, accounts }: AccountNameProps) {
  const label = useMemberAccountLabel({ cat, accounts });
  return (
    <AppTooltip label={label} intent="content" multiline showOnClick>
      <button type="button" className="member-cell-text" data-testid={`member-account-${cat.id}`}>
        {label}
      </button>
    </AppTooltip>
  );
}
