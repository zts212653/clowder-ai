import type { BuiltinAccountClient, ProfileItem } from './hub-accounts.types';

function inferBuiltinClient(profile: ProfileItem): BuiltinAccountClient | undefined {
  if (profile.clientId) return profile.clientId;
  if (profile.oauthLikeClient === 'opencode') return profile.oauthLikeClient;
  const normalizedId = `${profile.id} ${profile.provider ?? ''} ${profile.displayName} ${profile.name}`.toLowerCase();
  if (normalizedId.includes('claude')) return 'anthropic';
  if (normalizedId.includes('codex')) return 'openai';
  if (normalizedId.includes('gemini')) return 'google';
  if (normalizedId.includes('kimi') || normalizedId.includes('moonshot')) return 'kimi';
  if (normalizedId.includes('opencode')) return 'opencode';
  if (normalizedId.includes('acp')) return 'acp';
  return undefined;
}

export function normalizeBuiltinClientIds(profiles: ProfileItem[]): ProfileItem[] {
  return profiles.map((profile) => {
    if (!profile.builtin) return profile;
    const builtinClient = inferBuiltinClient(profile);
    return builtinClient ? { ...profile, clientId: builtinClient } : profile;
  });
}

export function builtinClientLabel(client?: BuiltinAccountClient): string {
  switch (client) {
    case 'anthropic':
      return 'Claude';
    case 'openai':
      return 'Codex';
    case 'google':
      return 'Gemini';
    case 'kimi':
      return 'Kimi';
    case 'opencode':
      return 'OpenCode';
    case 'acp':
      return 'ACP';
    default:
      return 'Builtin';
  }
}

export function accountTone(profile: ProfileItem): 'purple' | 'green' | 'orange' {
  if (profile.authType === 'oauth') return 'orange';
  if (profile.baseUrl?.toLowerCase().includes('google')) return 'green';
  return 'purple';
}

export function resolveAccountActionId(profile: ProfileItem): string {
  return profile.id;
}
