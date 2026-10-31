import { builtinAccountIdForClient, type ClientId } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import type { AccountMember, AccountSelection, ProfileItem } from '../hub-accounts.types';
import { builtinClientLabel } from '../hub-accounts.view';
import { accountMessage } from './account-message';
import { accountsCopy } from './accounts.shell-copy';

export function accountProvider(account: ProfileItem, t = accountsCopy.zh): string {
  if (account.authType === 'oauth') return builtinClientLabel(account.clientId);
  if (!account.baseUrl) return account.clientId ? builtinClientLabel(account.clientId) : t.customProvider;
  try {
    const host = new URL(account.baseUrl).hostname;
    const providers: Array<[string, string]> = [
      ['anthropic.com', 'Anthropic'],
      ['openai.com', 'OpenAI'],
      ['googleapis.com', 'Google'],
      ['moonshot.cn', 'Kimi'],
      ['moonshot.ai', 'Kimi'],
      ['minimax.io', 'MiniMax'],
      ['minimaxi.com', 'MiniMax'],
      ['deepseek.com', 'DeepSeek'],
      ['openrouter.ai', 'OpenRouter'],
    ];
    return providers.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1] ?? t.customProvider;
  } catch {
    return t.customProvider;
  }
}
export function accountMembers(account: ProfileItem, cats: CatData[], selection?: AccountSelection): AccountMember[] {
  if (['openai', 'anthropic'].includes(account.clientId ?? '') && selection)
    return selection.members.filter((m) => m.accountRef === account.id);
  return cats
    .filter(
      (cat) =>
        cat.id !== 'gpt-pro' &&
        cat.cli &&
        (cat.accountRef ?? builtinAccountIdForClient(cat.clientId as ClientId)) === account.id,
    )
    .map((cat) => ({
      id: cat.id,
      name: cat.nickname || cat.displayName,
      avatar: cat.avatar,
      accountRef: account.id,
      searchText: [cat.name, cat.displayName, cat.nickname, cat.breedDisplayName, cat.id].filter(Boolean).join(' '),
      available: cat.roster?.available !== false,
      bindingMode: cat.accountBindingMode,
    }));
}
export function accountIsSelected(account: ProfileItem, cats: CatData[], selection?: AccountSelection): boolean {
  if (['openai', 'anthropic'].includes(account.clientId ?? '')) return selection?.accountRef === account.id;
  const local = cats.filter(
    (cat) => cat.id !== 'gpt-pro' && cat.cli && cat.clientId === account.clientId && cat.roster?.available !== false,
  );
  return (
    local.length > 0 &&
    local.every((cat) => (cat.accountRef ?? builtinAccountIdForClient(cat.clientId as ClientId)) === account.id)
  );
}
export function accountLoginReady(account: ProfileItem) {
  if (account.claude) return account.claudeTokenStatus === 'saved';
  return account.codex ? account.codex.status === 'ready' : account.codexLoginStatus === 'ready';
}
export function accountStatus(account: ProfileItem, t = accountsCopy.zh, language: 'zh' | 'en' = 'zh') {
  if (account.claude)
    return {
      label:
        account.claudeTokenStatus === 'saved'
          ? t.tokenSaved
          : account.claudeTokenStatus === 'expired'
            ? t.tokenExpired
            : t.tokenMissing,
      detail: t.tokenIdentityUnknown,
      ready: account.claudeTokenStatus === 'saved',
    };
  if (account.authType === 'api_key')
    return { label: account.hasApiKey ? t.keyReady : t.keyMissing, detail: '', ready: false };
  const attempt = account.codex?.attempt;
  const ready = accountLoginReady(account);
  const waiting = ['preparing', 'queued', 'waiting'].includes(attempt?.state ?? '');
  let detail = account.nativeLogin?.identity?.email ?? '';
  if (waiting) detail = attempt?.state === 'waiting' ? t.awaitTerminal : t.preparingLogin;
  else if (attempt?.state === 'review') detail = t.reviewIdentity;
  else if (attempt?.error)
    detail = ready
      ? t.previousLoginFailed(accountMessage(attempt.error, language))
      : accountMessage(attempt.error, language);
  else if (attempt?.state === 'canceled') detail = t.canceledLogin;
  const unreadable =
    account.codexLoginStatus === 'unreadable' ||
    account.codex?.status === 'identity_changed' ||
    (!account.codex && !account.codexLoginStatus);
  return { label: ready ? t.loggedIn : waiting ? t.waiting : unreadable ? t.unreadable : t.notLoggedIn, detail, ready };
}

/** Translate product default names only; notes, emails and tool names remain user data. */
export function accountDisplayName(account: ProfileItem, t = accountsCopy.zh): string {
  if (!account.builtin) return account.displayName;
  if (account.displayName === 'Codex App 登录（本机默认）') return t.codexAppName;
  if (account.displayName === '本机默认登录') return t.nativeName;
  return account.displayName;
}
