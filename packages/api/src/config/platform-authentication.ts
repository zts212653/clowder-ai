/** The configured account owns both the credential and its destination. */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveGitCommonDir } from '../utils/monorepo-root.js';
import { accountToRuntimeProfile, type PlatformApiKeyClient, type RuntimeProviderProfile } from './account-resolver.js';
import { readAccountStoreSnapshot } from './account-store-snapshot.js';
import { assertProviderCredentialDestination } from './provider-credential-policy.js';
import { PROVIDER_BASE_URLS, parseProviderBaseUrl } from './provider-endpoint.js';

const CLIENTS = new Set<string>(['openai', 'anthropic', 'google']);
// A Google platform key means Vertex AI on Google Cloud billing, not AI Studio (operator 2026-11-10).
const PLATFORM_BASE_URLS: Readonly<Record<PlatformApiKeyClient, string>> = {
  openai: PROVIDER_BASE_URLS.openai,
  anthropic: PROVIDER_BASE_URLS.anthropic,
  google: 'https://aiplatform.googleapis.com',
};
const HEADERS: Readonly<Record<PlatformApiKeyClient, ReadonlySet<string>>> = {
  openai: new Set(['authorization']),
  anthropic: new Set(['authorization', 'x-api-key']),
  google: new Set(['x-goog-api-key']),
};

/** Shell cwd may be a consumer's project; the household config belongs to this host. */
export function platformAccountProjectRoot(start = fileURLToPath(new URL('../../../../', import.meta.url))): string {
  const active = resolveActiveProjectRoot(process.env.CAT_CAFE_WORKSPACE_ROOT ?? start);
  if (
    process.env.CAT_CAFE_WORKSPACE_ROOT?.trim() ||
    process.env.CAT_CAFE_CONFIG_ROOT?.trim() ||
    process.env.CAT_TEMPLATE_PATH?.trim()
  )
    return active;
  // A feature checkout carries host code, not another household account store.
  // The same Git common-root reader already establishes shared-project identity.
  const common = resolveGitCommonDir(active);
  return common ? dirname(common) : active;
}

export function platformAccountBaseUrl(profile: RuntimeProviderProfile, client: PlatformApiKeyClient): URL {
  let value = profile.baseUrl?.trim() || PLATFORM_BASE_URLS[client];
  const official = new URL(PLATFORM_BASE_URLS[client]);
  // Only the known official hostname may omit a scheme. Do not guess a gateway's protocol.
  if (value === official.hostname || value.startsWith(`${official.hostname}/`)) value = `https://${value}`;
  const url = parseProviderBaseUrl(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Platform account requires an HTTPS base URL without userinfo, query or fragment');
  assertProviderCredentialDestination(profile, client, url.href);
  return url;
}

export function assertPlatformAccountDestination(
  profile: RuntimeProviderProfile,
  client: PlatformApiKeyClient,
  destination: string,
): void {
  const base = platformAccountBaseUrl(profile, client);
  const url = new URL(destination);
  const prefix = base.pathname.replace(/\/+$/, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.origin !== base.origin ||
    (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
  )
    throw new Error('Platform credential destination differs from its registered account');
  assertProviderCredentialDestination(profile, client, url.href);
}

/** In-memory comparison against the canonical snapshot, never a second credential registry. */
export function authorizePlatformAuthentication(
  input: {
    destination: string;
    header: string;
    value: string;
  },
  projectRoot = platformAccountProjectRoot(),
): 'allowed' | 'denied' | 'unrecognized' {
  const header = input.header.toLowerCase();
  const key = header === 'authorization' ? /^Bearer ([^\s]+)$/i.exec(input.value)?.[1] : input.value;
  if (!key || /[\r\n]/u.test(key)) return 'unrecognized';
  const store = readAccountStoreSnapshot(projectRoot);
  let recognized = false;
  for (const ref of store.refs) {
    const verdict = store.inspect(ref);
    if (verdict.state !== 'resolved') continue;
    const { account, credential } = verdict.entry;
    if (account?.authType !== 'api_key' || !CLIENTS.has(account.clientId ?? '') || credential?.apiKey !== key) continue;
    recognized = true;
    const client = account.clientId as PlatformApiKeyClient;
    if (!HEADERS[client].has(header)) continue;
    try {
      assertPlatformAccountDestination(
        accountToRuntimeProfile(ref, account, credential, projectRoot),
        client,
        input.destination,
      );
      return 'allowed';
    } catch {
      // Another account using the same key may explicitly register this destination.
    }
  }
  return recognized ? 'denied' : 'unrecognized';
}
