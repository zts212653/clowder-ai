import type { ProfileItem } from '../hub-accounts.types';
import { builtinAccountIdForClient, type ClientValue } from '../hub-cat-editor.model';

export interface ClientModelDefaults {
  defaultModel?: string;
  models?: string[];
}

export function withNativeProfile(
  profiles: ProfileItem[],
  clientId: string,
  detectedAuth: boolean | 'oauth' | 'environment',
  defaults?: ClientModelDefaults,
): ProfileItem[] {
  const id = builtinAccountIdForClient(clientId as ClientValue);
  if (!detectedAuth || !id || profiles.some((profile) => profile.id === id)) return profiles;
  const authType = detectedAuth === 'environment' ? 'api_key' : 'oauth';
  const models = [
    ...new Set([defaults?.defaultModel, ...(defaults?.models ?? [])].filter((model): model is string => !!model)),
  ];
  // The API resolver already supports these builtin refs on fresh installs.
  // This is a view of the CLI-owned identity, never a new credential record.
  return [
    {
      id,
      clientId: clientId as ProfileItem['clientId'],
      name: '本机 CLI 登录',
      displayName: '本机 CLI 登录',
      authType,
      kind: 'builtin',
      builtin: true,
      syntheticNative: true,
      mode: authType === 'api_key' ? 'api_key' : 'subscription',
      models,
      hasApiKey: authType === 'api_key',
      createdAt: '',
      updatedAt: '',
    },
    ...profiles,
  ];
}
