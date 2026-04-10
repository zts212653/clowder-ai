'use client';

import type { CatData } from '@/hooks/useCatData';
import type { BuiltinAccountClient, ProfileItem } from './hub-accounts.types';
import type { CodexUsageItem, QuotaResponse } from './quota-cards';

export interface AccountQuotaPool {
  id: string;
  title: string;
  items: CodexUsageItem[];
  memberTags: string[];
  emptyText?: string;
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
  dare: 'Dare',
  opencode: 'OpenCode',
};

const BUILTIN_ACCOUNT_IDS: Record<BuiltinAccountClient, string> = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  dare: 'dare',
  opencode: 'opencode',
};

function builtinDisplayName(client: BuiltinAccountClient): string {
  switch (client) {
    case 'anthropic':
      return 'Claude (OAuth)';
    case 'openai':
      return 'Codex (OAuth)';
    case 'google':
      return 'Gemini (OAuth)';
    case 'dare':
      return 'Dare (client-auth)';
    case 'opencode':
      return 'OpenCode (client-auth)';
  }
}

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
    case 'dare':
      return 'dare';
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

function builtinQuotaItems(accountId: string, quota: QuotaResponse | null): CodexUsageItem[] {
  switch (accountId) {
    case 'claude':
      return quota?.claude.usageItems ?? [];
    case 'codex':
      return quota?.codex.usageItems ?? [];
    case 'gemini':
      return quota?.gemini?.usageItems ?? [];
    default:
      return [];
  }
}

function builtinEmptyText(accountId: string): string {
  switch (accountId) {
    case 'claude':
    case 'codex':
      return '暂无数据，点击刷新获取';
    case 'gemini':
      return '暂无数据（需 ClaudeBar 推送）';
    case 'dare':
      return 'Dare 不单独上报官方额度，实际额度取决于绑定账号';
    case 'opencode':
      return 'OpenCode 不单独上报官方额度，实际额度取决于绑定账号';
    default:
      return '暂无数据';
  }
}

export function buildAccountQuotaGroups(
  quota: QuotaResponse | null,
  profiles: ProfileItem[],
  cats: CatData[],
): AccountQuotaPoolGroup[] {
  const builtinProfiles =
    profiles.filter((profile) => profile.builtin).length > 0
      ? profiles.filter((profile) => profile.builtin)
      : (Object.entries(BUILTIN_ACCOUNT_IDS) as Array<[BuiltinAccountClient, string]>).map(([client, id]) => ({
          id,
          displayName: builtinDisplayName(client),
          clientId: client,
          builtin: true,
          authType: 'oauth' as const,
        }));

  const builtinPools = builtinProfiles.map<AccountQuotaPool>((profile) => ({
    id: profile.id,
    title: profile.displayName || BUILTIN_CLIENT_LABELS[profile.clientId ?? 'anthropic'],
    items: builtinQuotaItems(profile.id, quota),
    memberTags: memberTagsForAccount(cats, profile.id),
    emptyText: builtinEmptyText(profile.id),
  }));

  const apiKeyPools = profiles
    .filter((profile) => profile.authType === 'api_key' && !profile.builtin)
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
      title: '内置账号额度（按账号配置）',
      description: '固定内置账号包括 Claude / Codex / Gemini / Dare / OpenCode，每个账号下方反向显示绑定成员。',
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
