import { type AccountQuotaObservation, accountQuotaOwnerMatches } from '@cat-cafe/shared';
import { accountLoginReady } from '../accounts/account-directory-view';
import type { ProfileItem } from '../hub-accounts.types';

export function quotaFailureKind(observation: AccountQuotaObservation) {
  return (
    observation.failure?.kind ??
    (/登录凭据已过期/.test(observation.error ?? '')
      ? 'renewal_required'
      : /请先.*登录/.test(observation.error ?? '')
        ? 'signin_required'
        : 'service_unreachable')
  );
}
export function remainingQuota(item: AccountQuotaObservation['items'][number]) {
  return Math.max(0, Math.min(100, item.percentKind === 'remaining' ? item.usedPercent : 100 - item.usedPercent));
}
export function availableAccountQuota(account: ProfileItem, includePrevious = false) {
  const quota = account.quota;
  const native = account.nativeLogin?.identity;
  const identity = account.codex?.identity ?? (native?.userId ? { ...native, userId: native.userId } : undefined);
  const items = quota?.status === 'ok' ? quota.items : includePrevious ? quota?.lastSuccess?.items : undefined;
  if (
    !accountLoginReady(account) ||
    !items?.length ||
    !identity ||
    !accountQuotaOwnerMatches(quota, account.id, identity)
  )
    return undefined;
  return Math.min(...items.map(remainingQuota));
}
export function nextQuotaAccount(account: ProfileItem, accounts: ProfileItem[]) {
  const left = availableAccountQuota(account, true);
  if (left === undefined || left >= 20) return undefined;
  return accounts
    .filter(
      (candidate) =>
        candidate.id !== account.id && candidate.clientId === account.clientId && candidate.authType === 'oauth',
    )
    .map((candidate) => ({ account: candidate, left: availableAccountQuota(candidate) }))
    .filter(
      (candidate): candidate is { account: ProfileItem; left: number } =>
        candidate.left !== undefined && candidate.left > left,
    )
    .sort((a, b) => b.left - a.left || a.account.id.localeCompare(b.account.id))[0];
}
