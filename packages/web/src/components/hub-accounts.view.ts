import type { BuiltinAccountClient, ProfileItem } from './hub-accounts.types';

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
    case 'dare':
      return 'Dare';
    case 'opencode':
      return 'OpenCode';
    default:
      return '';
  }
}

export function accountTone(profile: ProfileItem): 'purple' | 'green' | 'orange' {
  if (profile.authType === 'oauth') return 'orange';
  if (profile.baseUrl?.toLowerCase().includes('google')) return 'green';
  return 'purple';
}
