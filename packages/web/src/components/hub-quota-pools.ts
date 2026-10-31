'use client';

import { accountQuotaOwnerMatches } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import type { BuiltinAccountClient, ProfileItem } from './hub-accounts.types';
import type { ConfiguredQuotaPlatforms } from './hub-quota-refresh';
import { type CodexUsageItem, type QuotaResponse, toUtilization } from './quota-cards';

export interface AccountQuotaPool {
  id: string;
  title: string;
  items: CodexUsageItem[];
  memberTags: string[];
  emptyText?: string;
  checkedAt?: number;
}

export interface AccountQuotaPoolGroup {
  id: string;
  title: string;
  description: string;
  tone?: 'default' | 'success';
  pools: AccountQuotaPool[];
}

const BUILTIN_CLIENT_LABELS: Record<BuiltinAccountClient, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
  google: 'Gemini',
  kimi: 'Kimi',
  opencode: 'OpenCode',
  acp: 'ACP',
};

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.filter(Boolean))];
}

function memberTag(cat: CatData): string {
  return cat.mentionPatterns[0] ?? `@${cat.id}`;
}

function fallbackAccountRef(cat: CatData): string | null {
  switch (cat.clientId) {
    case 'anthropic':
      return 'claude';
    case 'openai':
      return 'codex';
    case 'google':
      return 'gemini';
    case 'kimi':
      return 'kimi';
    case 'opencode':
      return 'opencode';
    default:
      return null;
  }
}

function memberTagsForAccount(cats: CatData[], accountId: string): string[] {
  return uniqueTags(
    cats
      .filter((cat) => {
        const boundAccountRef = cat.accountRef?.trim() || fallbackAccountRef(cat);
        return boundAccountRef === accountId;
      })
      .map(memberTag),
  );
}

function builtinQuotaItems(clientId: BuiltinAccountClient | undefined, quota: QuotaResponse | null): CodexUsageItem[] {
  switch (clientId) {
    case 'anthropic':
      return quota?.claude.usageItems ?? [];
    case 'openai':
      return quota?.codex.usageItems ?? [];
    case 'google':
      return quota?.gemini?.usageItems ?? [];
    case 'kimi':
      return quota?.kimi?.usageItems ?? [];
    default:
      return [];
  }
}

function builtinEmptyText(clientId: BuiltinAccountClient | undefined): string {
  switch (clientId) {
    case 'anthropic':
    case 'openai':
      return '暂无数据，点击刷新获取';
    case 'google':
      return '暂无数据（需 ClaudeBar 推送）';
    case 'kimi':
      return '默认通过 Kimi CLI /usage 获取；如需 API 降级，配置 KIMI_QUOTA_API_FALLBACK_ENABLED=1 与 KIMI_AUTH_TOKEN';
    case 'opencode':
      return 'OpenCode 不单独上报官方额度，实际额度取决于绑定账号';
    default:
      return '暂无数据';
  }
}

export function managedQuotaIsCurrent(profile: ProfileItem): boolean {
  return (
    profile.codex?.status === 'ready' && accountQuotaOwnerMatches(profile.quota, profile.id, profile.codex.identity)
  );
}

function managedQuotaEmptyText(profile: ProfileItem): string {
  if (profile.codex?.status === 'identity_changed') return '登录身份已变化，请先处理此账号登录';
  if (profile.codex?.status !== 'ready') return '尚未登录，请先完成此账号的官方登录';
  if (profile.quota && !managedQuotaIsCurrent(profile)) return '此账号额度身份未确认，请重新查询';
  return profile.quota?.error ?? '尚未查询此账号额度，不代表额度为零';
}

export function buildAccountQuotaGroups(
  quota: QuotaResponse | null,
  profiles: ProfileItem[],
  cats: CatData[],
): AccountQuotaPoolGroup[] {
  const oauthProfiles = profiles.filter((profile) => profile.authType === 'oauth');

  const builtinPools = oauthProfiles.map<AccountQuotaPool>((profile) => ({
    id: profile.id,
    title: profile.displayName || BUILTIN_CLIENT_LABELS[profile.clientId ?? 'anthropic'],
    // The aggregate observation belongs to the native default, never another login.
    items: profile.codex
      ? managedQuotaIsCurrent(profile) && profile.quota?.status === 'ok'
        ? [...profile.quota.items]
        : []
      : builtinQuotaItems(profile.clientId, quota),
    memberTags: memberTagsForAccount(cats, profile.id),
    emptyText: profile.codex ? managedQuotaEmptyText(profile) : builtinEmptyText(profile.clientId),
    ...(profile.codex && managedQuotaIsCurrent(profile) && profile.quota
      ? { checkedAt: profile.quota.observedAt }
      : {}),
  }));

  const apiKeyPools = profiles
    .filter((profile) => profile.authType === 'api_key')
    .map<AccountQuotaPool>((profile) => ({
      id: profile.id,
      title: profile.displayName,
      items: [],
      memberTags: memberTagsForAccount(cats, profile.id),
      emptyText: '按账单周期计费，暂不展示官方用量',
    }));

  const antigravityMemberTags = uniqueTags(cats.filter((cat) => cat.clientId === 'antigravity').map(memberTag));
  const antigravityPools: AccountQuotaPool[] =
    antigravityMemberTags.length > 0 || (quota?.antigravity?.usageItems.length ?? 0) > 0
      ? [
          {
            id: 'antigravity',
            title: 'Antigravity Bridge',
            items: quota?.antigravity?.usageItems ?? [],
            memberTags: antigravityMemberTags,
            emptyText: '暂无数据（需 Bridge 上报）',
          },
        ]
      : [];

  const groups: AccountQuotaPoolGroup[] = [
    {
      id: 'builtin',
      title: 'OAuth 账号额度（按账号配置）',
      description: 'OAuth 账号包括 Claude / Codex / Gemini / Kimi / OpenCode，每个账号下方反向显示绑定成员。',
      pools: builtinPools,
    },
    {
      id: 'api-key',
      title: 'API Key 额度（按账号配置）',
      description: '独立 API Key 账号不预绑定 client；成员绑定后在对应账号下方反向显示。',
      tone: 'success',
      pools: apiKeyPools,
    },
  ];

  if (antigravityPools.length > 0) {
    groups.push({
      id: 'antigravity',
      title: 'Antigravity Bridge（独立通道）',
      description: 'Bridge 通道单独展示，不混入账号池。',
      pools: antigravityPools,
    });
  }

  return groups;
}

export function resolveAccountQuotaRisk(
  quota: QuotaResponse | null,
  refreshError: string | null,
  configured: ConfiguredQuotaPlatforms,
  profiles: ProfileItem[],
  groups: AccountQuotaPoolGroup[],
): 'ok' | 'warn' | 'high' {
  if (
    refreshError ||
    (configured.codex && quota?.codex?.error) ||
    (configured.claude && quota?.claude?.error) ||
    (configured.gemini && quota?.gemini?.error) ||
    (configured.kimi && quota?.kimi?.error) ||
    (configured.antigravity && quota?.antigravity?.error) ||
    profiles.some((profile) => profile.codex && managedQuotaIsCurrent(profile) && profile.quota?.error)
  )
    return 'high';
  const max = Math.max(0, ...groups.flatMap((group) => group.pools.flatMap((pool) => pool.items.map(toUtilization))));
  if (max >= 95) return 'high';
  if (max >= 80) return 'warn';
  return 'ok';
}
