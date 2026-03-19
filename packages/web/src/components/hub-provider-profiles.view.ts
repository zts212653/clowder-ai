import type { BuiltinAccountClient, ProfileItem } from './hub-provider-profiles.types';

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
