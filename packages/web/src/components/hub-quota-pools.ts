'use client';

import type { CatData } from '@/hooks/useCatData';
import type { ProfileItem } from './hub-provider-profiles.types';
import type { CodexUsageItem, QuotaResponse } from './quota-cards';

export interface AccountQuotaPool {
  id: string;
  title: string;
  items: CodexUsageItem[];
  memberTags: string[];
  emptyText?: string;
}

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.filter(Boolean))];
}

function memberTag(cat: CatData): string {
  return cat.mentionPatterns[0] ?? `@${cat.id}`;
}

function memberTagsForPool(cats: CatData[], profileId: string, providerFallback: string): string[] {
  return uniqueTags(
    cats
      .filter((cat) => cat.providerProfileId === profileId || (!cat.providerProfileId && cat.provider === providerFallback))
      .map(memberTag),
  );
}

export function buildAccountQuotaPools(
  quota: QuotaResponse | null,
  profiles: ProfileItem[],
  cats: CatData[],
): AccountQuotaPool[] {
  const builtinPools: AccountQuotaPool[] = [
    {
      id: 'claude-oauth',
      title: 'Claude 订阅',
      items: quota?.claude.usageItems ?? [],
      memberTags: memberTagsForPool(cats, 'claude-oauth', 'anthropic'),
      emptyText: '暂无数据，点击刷新获取',
    },
    {
      id: 'codex-oauth',
      title: 'Codex 订阅',
      items: quota?.codex.usageItems ?? [],
      memberTags: memberTagsForPool(cats, 'codex-oauth', 'openai'),
      emptyText: '暂无数据，点击刷新获取',
    },
    {
      id: 'gemini-oauth',
      title: 'Gemini 订阅',
      items: quota?.gemini?.usageItems ?? [],
      memberTags: memberTagsForPool(cats, 'gemini-oauth', 'google'),
      emptyText: '暂无数据（需 ClaudeBar 推送）',
    },
  ];

  const apiKeyPools = profiles
    .filter((profile) => profile.authType === 'api_key' && !profile.builtin)
    .map<AccountQuotaPool>((profile) => ({
      id: profile.id,
      title: profile.displayName,
      items: [],
      memberTags: uniqueTags(cats.filter((cat) => cat.providerProfileId === profile.id).map(memberTag)),
      emptyText: '暂无官方额度数据',
    }));

  const antigravityPool: AccountQuotaPool = {
    id: 'antigravity',
    title: 'Antigravity Bridge',
    items: quota?.antigravity?.usageItems ?? [],
    memberTags: uniqueTags(cats.filter((cat) => cat.provider === 'antigravity').map(memberTag)),
    emptyText: '暂无数据（需 ClaudeBar 推送）',
  };

  return [...builtinPools, ...apiKeyPools, antigravityPool];
}
