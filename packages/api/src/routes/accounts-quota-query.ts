import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AccountQuotaObservation, accountQuotaOwnerMatches, type CodexManagedAccount } from '@cat-cafe/shared';
import { resolveByAccountRef } from '../config/account-resolver.js';
import { readAccountStoreSnapshot } from '../config/account-store-snapshot.js';
import { writeCatalogAccount } from '../config/catalog-accounts.js';
import {
  codexIdentityFromAuth,
  codexManagedStatus,
  readCodexAccountIdentity,
  sameCodexIdentity,
} from '../config/codex-account-identity.js';
import { resolveCodexAccountLaunch } from '../config/codex-account-launch.js';
import { renewCodexQuotaLogin } from '../config/codex-quota-renewal.js';
import { officialQuotaFailure, projectQuotaRenewal, quotaCredentialVersion } from './accounts-quota-feedback.js';
import { parseCodexWhamUsageResponse } from './quota.js';

export class QuotaCredentialChanged extends Error {}

function managedQuotaOwnerUnchanged(
  requested: CodexManagedAccount,
  current: CodexManagedAccount | undefined,
  wasReady: boolean,
): boolean {
  if (!current || current.credentialHome !== requested.credentialHome) return false;
  if ((requested.identity || current.identity) && !sameCodexIdentity(requested.identity, current.identity))
    return false;
  return !wasReady || sameCodexIdentity(requested.identity, readCodexAccountIdentity(requested.credentialHome));
}

/** Official usage GET; only an explicit expired-login retry can request native diagnostics. */
export async function queryAccountQuota(
  root: string,
  profileId: string,
  fetcher: typeof fetch,
  automaticVersion?: string,
  renewExpired = false,
  renewer: typeof renewCodexQuotaLogin = renewCodexQuotaLogin,
) {
  const profile = resolveByAccountRef(root, profileId);
  if (!profile || profile.client !== 'openai') throw new Error('Codex account not found');
  const previousAttempt = readAccountStoreSnapshot(root).resolve(profileId).account?.quota;
  const expired =
    previousAttempt?.failure?.kind === 'renewal_required' || /登录凭据已过期/.test(previousAttempt?.error ?? '');
  const homeForRenewal =
    renewExpired && expired ? resolveCodexAccountLaunch(profile, { cwd: root }).credentialHome : undefined;
  if (renewExpired && expired && !projectQuotaRenewal(previousAttempt, homeForRenewal)?.renewedCredentialVersion) {
    try {
      await renewer(profile, root);
    } catch (error) {
      if (error instanceof Error && error.message === 'quota_renewal_identity_changed')
        throw new QuotaCredentialChanged();
      // A failed diagnostic does not become a fabricated quota result; query the official endpoint next.
    }
  }
  let requestedIdentity = profile.codex?.identity;
  let credentialHome: string | undefined;
  const wasReady = !!profile.codex && codexManagedStatus(profile.codex) === 'ready';
  let observation: AccountQuotaObservation;
  let credentialVersion: string | undefined;
  let failure: AccountQuotaObservation['failure'];
  if (profile.authType === 'api_key')
    observation = {
      observedAt: Date.now(),
      source: 'codex_official_readonly',
      status: 'unsupported',
      items: [],
      error: 'API 账号请在服务商账单页查看余额',
    };
  else {
    try {
      if (profile.codex && codexManagedStatus(profile.codex) !== 'ready') throw new Error('login_required');
      const home = resolveCodexAccountLaunch(profile, { cwd: root }).credentialHome;
      credentialHome = home;
      let raw: string;
      try {
        raw = readFileSync(join(home, 'auth.json'), 'utf8');
      } catch {
        throw new Error('login_required');
      }
      if (raw.length > 262144) throw new Error('credentials_invalid');
      if (profile.codex && !sameCodexIdentity(profile.codex.identity, codexIdentityFromAuth(raw)))
        throw new Error('login_required');
      let auth: { tokens?: { access_token?: string; account_id?: string } };
      try {
        auth = JSON.parse(raw);
      } catch {
        throw new Error('credentials_invalid');
      }
      const tokens = auth.tokens;
      if (
        typeof tokens?.access_token !== 'string' ||
        !tokens.access_token ||
        typeof tokens.account_id !== 'string' ||
        !tokens.account_id
      )
        throw new Error('login_required');
      credentialVersion = quotaCredentialVersion(tokens.access_token);
      if (!profile.codex) requestedIdentity = codexIdentityFromAuth(raw);
      if (automaticVersion) {
        if (automaticVersion !== credentialVersion) throw new QuotaCredentialChanged();
        const cached = readAccountStoreSnapshot(root).resolve(profileId).account?.quota;
        if (
          cached?.credentialVersion === automaticVersion &&
          (!requestedIdentity || accountQuotaOwnerMatches(cached, profileId, requestedIdentity))
        )
          return { accountRef: profileId, quota: cached };
      }
      const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'ChatGPT-Account-Id': tokens.account_id,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const tokenValues = Object.values(auth.tokens ?? {}).filter((v): v is string => typeof v === 'string');
        failure = await officialQuotaFailure(response, tokenValues);
        throw new Error(failure.kind);
      }
      const items = parseCodexWhamUsageResponse(
        (await response.json()) as Parameters<typeof parseCodexWhamUsageResponse>[0],
        response.headers,
      );
      if (!items.length) throw new Error('quota_unavailable');
      observation = {
        observedAt: Date.now(),
        source: 'codex_official_readonly',
        status: 'ok',
        items,
        credentialVersion,
      };
    } catch (error) {
      if (error instanceof QuotaCredentialChanged) throw error;
      observation = {
        observedAt: Date.now(),
        source: 'codex_official_readonly',
        status: 'unavailable',
        items: [],
        credentialVersion,
        failure: failure ?? {
          kind: /login_required|credentials_invalid/.test(String(error)) ? 'signin_required' : 'service_unreachable',
        },
        error:
          failure?.kind === 'renewal_required'
            ? '登录凭据已过期，请让官方 Codex 完成续期后再查询'
            : failure?.kind === 'signin_required' || /login_required|credentials_invalid/.test(String(error))
              ? '请先完成此账号的官方登录'
              : '暂时无法查询此账号额度，请重试',
      };
    }
  }
  const current = readAccountStoreSnapshot(root).resolve(profileId).account;
  // The same ref may now name another principal. Reject late results before synchronous write.
  if (!current || (profile.codex && !managedQuotaOwnerUnchanged(profile.codex, current.codex, wasReady)))
    throw new QuotaCredentialChanged();
  if (!profile.codex && credentialHome) {
    const resolved = resolveByAccountRef(root, profileId);
    if (
      !resolved ||
      resolveCodexAccountLaunch(resolved, { cwd: root }).credentialHome !== credentialHome ||
      (requestedIdentity && !sameCodexIdentity(requestedIdentity, readCodexAccountIdentity(credentialHome)))
    )
      throw new QuotaCredentialChanged();
  }
  if (requestedIdentity)
    observation = {
      ...observation,
      owner: {
        accountRef: profileId,
        userId: requestedIdentity.userId,
        workspaceId: requestedIdentity.workspaceId,
      },
    };
  const previous = current.quota;
  const sameOwner = requestedIdentity
    ? accountQuotaOwnerMatches(previous, profileId, requestedIdentity)
    : !!credentialVersion && previous?.credentialVersion === credentialVersion;
  if (observation.status === 'unavailable' && previous && sameOwner && (!profile.codex || wasReady)) {
    const lastSuccess =
      previous.status === 'ok' ? { observedAt: previous.observedAt, items: previous.items } : previous.lastSuccess;
    if (lastSuccess) observation = { ...observation, lastSuccess };
  }
  // Preserve a concurrently changed note/attempt, without recreating a deleted account.
  writeCatalogAccount(root, profileId, { ...current, quota: observation });
  return { accountRef: profileId, quota: observation };
}
