import { type AccountQuotaObservation, accountQuotaOwnerMatches } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import type { ProfileItem } from './hub-accounts.types';

export interface ConfiguredQuotaPlatforms {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  kimi: boolean;
  antigravity: boolean;
}

/** A fresh list may contain an earlier observation, but never preserves another principal's data. */
export function reconcileQuotaProfiles(next: ProfileItem[], current: ProfileItem[]): ProfileItem[] {
  return next.map((profile) => {
    const previous = current.find((entry) => entry.id === profile.id)?.quota;
    return profile.codex?.status === 'ready' &&
      previous &&
      accountQuotaOwnerMatches(previous, profile.id, profile.codex.identity) &&
      previous.observedAt > (profile.quota?.observedAt ?? -Infinity)
      ? { ...profile, quota: previous }
      : profile;
  });
}

export function projectAccountQuota(
  profiles: ProfileItem[],
  accountRef: string,
  observation: AccountQuotaObservation,
): ProfileItem[] | undefined {
  const current = profiles.find((entry) => entry.id === accountRef);
  if (current?.codex?.status !== 'ready' || !accountQuotaOwnerMatches(observation, accountRef, current.codex.identity))
    return;
  return profiles.map((entry) => (entry.id === accountRef ? { ...entry, quota: observation } : entry));
}

function quotaRefreshWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === 'string' && !!warning.trim());
}

/** Preserve native aggregate probes; managed Codex logins use their own account endpoint. */
export async function refreshAccountQuotaPools(
  profiles: ProfileItem[],
  configured: ConfiguredQuotaPlatforms,
  observe: (accountRef: string, quota: AccountQuotaObservation) => void,
): Promise<string[]> {
  const requests: Array<{ path: string; label: string; body: unknown; accountRef?: string }> = [];
  const providers: Array<'claude' | 'codex'> = [];
  if (configured.claude) providers.push('claude');
  if (configured.codex) providers.push('codex');
  if (providers.length)
    requests.push({
      path: '/api/quota/refresh/official',
      label: '获取官方额度失败',
      body: { interactive: true, providers },
    });
  for (const profile of profiles.filter((entry) => entry.clientId === 'openai' && entry.codex?.status === 'ready')) {
    requests.push({
      path: `/api/accounts/${encodeURIComponent(profile.id)}/codex/quota`,
      label: `${profile.displayName}额度查询失败`,
      body: {},
      accountRef: profile.id,
    });
  }
  if (configured.claude) requests.push({ path: '/api/quota/refresh/claude', label: '刷新 Claude 额度失败', body: {} });
  if (configured.kimi) requests.push({ path: '/api/quota/refresh/kimi', label: '刷新 Kimi 额度失败', body: {} });
  const results = await Promise.all(
    requests.map(async ({ path, label, body, accountRef }) => {
      const errors: string[] = [];
      try {
        const response = await apiFetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = (await response.json().catch(() => ({}))) as {
          error?: unknown;
          warnings?: unknown;
          accountRef?: string;
          quota?: AccountQuotaObservation;
        };
        errors.push(...quotaRefreshWarnings(result.warnings));
        if (!response.ok) {
          errors.push(typeof result.error === 'string' && result.error.trim() ? result.error : label);
          return errors;
        }
        if (!accountRef) return errors;
        if (result.accountRef !== accountRef || !result.quota) return [...errors, label];
        observe(accountRef, result.quota);
        if (result.quota.error) errors.push(`${label}：${result.quota.error}`);
      } catch {
        errors.push(label);
      }
      return errors;
    }),
  );
  return [...new Set(results.flat())];
}
