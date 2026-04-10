import type { BuiltinAccountClient, ProfileItem } from './hub-accounts.types';

const FALLBACK_BUILTIN_PROFILE_SPECS: Array<{
  clientId: BuiltinAccountClient;
  id: string;
  displayName: string;
  models: string[];
}> = [
  { clientId: 'anthropic', id: 'claude', displayName: 'Claude (OAuth)', models: [] },
  { clientId: 'openai', id: 'codex', displayName: 'Codex (OAuth)', models: [] },
  { clientId: 'google', id: 'gemini', displayName: 'Gemini (OAuth)', models: [] },
  { clientId: 'dare', id: 'dare', displayName: 'Dare (client-auth)', models: [] },
  { clientId: 'opencode', id: 'opencode', displayName: 'OpenCode (client-auth)', models: [] },
];

function inferBuiltinClient(profile: ProfileItem): BuiltinAccountClient | undefined {
  if (profile.clientId) return profile.clientId;
  if (profile.oauthLikeClient === 'dare' || profile.oauthLikeClient === 'opencode') return profile.oauthLikeClient;
  const normalizedId = `${profile.id} ${profile.provider ?? ''} ${profile.displayName} ${profile.name}`.toLowerCase();
  if (normalizedId.includes('claude')) return 'anthropic';
  if (normalizedId.includes('codex')) return 'openai';
  if (normalizedId.includes('gemini')) return 'google';
  if (normalizedId.includes('dare')) return 'dare';
  if (normalizedId.includes('opencode')) return 'opencode';
  return undefined;
}

export function ensureBuiltinAccounts(profiles: ProfileItem[]): ProfileItem[] {
  const normalized = profiles.map((profile) => {
    if (!profile.builtin) return profile;
    const builtinClient = inferBuiltinClient(profile);
    return builtinClient ? { ...profile, clientId: builtinClient } : profile;
  });

  const seenBuiltinClients = new Set(
    normalized
      .filter((profile) => profile.builtin)
      .map((profile) => inferBuiltinClient(profile))
      .filter(Boolean) as BuiltinAccountClient[],
  );

  for (const spec of FALLBACK_BUILTIN_PROFILE_SPECS) {
    if (seenBuiltinClients.has(spec.clientId)) continue;
    normalized.push({
      id: spec.id,
      displayName: spec.displayName,
      name: spec.displayName,
      authType: 'oauth',
      kind: 'builtin',
      builtin: true,
      mode: 'subscription',
      clientId: spec.clientId,
      models: spec.models,
      hasApiKey: false,
      createdAt: '',
      updatedAt: '',
      ...(spec.clientId === 'dare' || spec.clientId === 'opencode' ? { oauthLikeClient: spec.clientId } : {}),
    });
  }

  return normalized;
}

export function builtinClientLabel(client?: BuiltinAccountClient): string {
  switch (client) {
    case 'anthropic':
      return 'Claude';
    case 'openai':
      return 'Codex';
    case 'google':
      return 'Gemini';
    case 'dare':
      return 'Dare';
    case 'opencode':
      return 'OpenCode';
    default:
      return 'Builtin';
  }
}

export function accountTone(profile: ProfileItem): 'purple' | 'green' | 'orange' {
  if (profile.builtin) return 'orange';
  if (profile.baseUrl?.toLowerCase().includes('google')) return 'green';
  return 'purple';
}

export function resolveAccountActionId(profile: ProfileItem): string {
  return profile.id;
}
