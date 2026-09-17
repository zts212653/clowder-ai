/** Credential identity is independent of authentication mode and wire protocol. */
import {
  type AccountProtocol,
  BUILTIN_ACCOUNT_CLIENT_FOR_ID,
  type BuiltinAccountClient,
  legacyAccountFamilyForRef,
} from '@cat-cafe/shared';
import type { RuntimeProviderProfile } from './account-resolver.js';
import { AccountStoreVerdictError } from './account-store-format.js';
import { parseProviderBaseUrl } from './provider-endpoint.js';

const OFFICIAL_DOMAINS: Readonly<Record<string, BuiltinAccountClient>> = {
  'anthropic.com': 'anthropic',
  'openai.com': 'openai',
  'googleapis.com': 'google',
  'moonshot.ai': 'kimi',
  'moonshot.cn': 'kimi',
  'kimi.com': 'kimi',
};

export function officialProviderFamily(hostname: string): BuiltinAccountClient | null {
  const normalized = hostname.toLowerCase().replace(/\.+$/, '');
  for (const [domain, family] of Object.entries(OFFICIAL_DOMAINS)) {
    if (normalized === domain || normalized.endsWith(`.${domain}`)) return family;
  }
  return null;
}

export function profileFamilyIdentity(profile: RuntimeProviderProfile): BuiltinAccountClient | null {
  if (profile.persistedClientId !== undefined) {
    return Object.values(BUILTIN_ACCOUNT_CLIENT_FOR_ID).find((family) => family === profile.persistedClientId) ?? null;
  }
  return profile.client ?? legacyAccountFamilyForRef(profile.id);
}

/** Call only with the actual destination. Never authorize a gateway then fetch an official URL. */
export function assertProviderCredentialDestination(
  profile: RuntimeProviderProfile,
  protocol: AccountProtocol,
  endpoint: string,
): void {
  const url = parseProviderBaseUrl(endpoint);
  const hostFamily = officialProviderFamily(url.hostname);
  if (url.username || url.password) {
    throw new AccountStoreVerdictError(`account "${profile.id}" endpoint URL must not contain userinfo`);
  }
  // Compatible wire protocols do not change who owns a key (e.g. Kimi's OpenAI API).
  if (hostFamily && profileFamilyIdentity(profile) !== hostFamily) {
    throw new AccountStoreVerdictError(
      `bound provider profile "${profile.id}" identity is incompatible with ${protocol} at official ${hostFamily} endpoint`,
    );
  }
}
