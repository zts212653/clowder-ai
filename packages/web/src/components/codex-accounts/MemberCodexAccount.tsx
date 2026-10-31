'use client';
import type { CatData } from '@/hooks/useCatData';
import type { ProfileItem } from '../hub-accounts.types';

function accountChoiceLabel(account: ProfileItem, accounts: ProfileItem[]): string {
  if (!accounts.some((other) => other.id !== account.id && other.displayName === account.displayName))
    return account.displayName;
  const identity = account.codex?.identity;
  return identity
    ? `${account.displayName} · ${identity.email ?? '官方账号'} · 工作区 ${identity.workspaceId}`
    : `${account.displayName} · ${account.id}`;
}

export function MemberCodexAccount({ cat, accounts }: { cat: CatData; accounts: ProfileItem[] }) {
  if (cat.id === 'gpt-pro') return <small>云端独立接入</small>;
  if (cat.clientId !== 'openai' || !cat.cli) return null;
  const account = accounts.find((p) => p.id === (cat.accountRef ?? 'codex'));
  return (
    <small data-testid={`member-account-${cat.id}`}>
      号：{account ? accountChoiceLabel(account, accounts) : (cat.accountRef ?? '本机默认登录')}
      {cat.accountBindingMode === 'override' ? ' · 单独指定' : ''}
    </small>
  );
}
