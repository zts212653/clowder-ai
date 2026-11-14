/** Where a platform request goes and how the host authenticates it. The selected account decides both. */
import { configuredCredentialValues } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { resolvePlatformApiKeyAccount } from '../../../config/account-resolver.js';
import { resolveGoogleCloudPlatformAccount } from '../../../config/google-cloud-account.js';
import { assertPlatformAccountDestination, platformAccountBaseUrl } from '../../../config/platform-authentication.js';
import { exchangeGoogleCloudAccessToken, readLocalAdc } from './google-cloud-auth.js';
import {
  assertInferencePath,
  googleCloudVertexOrigin,
  type PlatformProvider,
  type PlatformRequest,
} from './request-contract.js';

export interface PlatformTarget {
  readonly provider: PlatformProvider;
  readonly url: string;
  /** Values that must never appear in the request, its output location or the response. */
  readonly credentials: readonly string[];
  /** Re-check the destination, then set host-owned authentication, immediately before the only send. */
  authenticate(headers: Headers): void;
}

interface Transport {
  fetch: typeof fetch;
  signal: AbortSignal;
}

// Each API-key provider names its host-owned header and the version suffix an account base URL may carry.
const API_KEY_WIRE: Record<PlatformProvider, { header: (key: string) => [string, string]; version: RegExp }> = {
  openai: { header: (key) => ['authorization', `Bearer ${key}`], version: /\/v1$/u },
  google: { header: (key) => ['x-goog-api-key', key], version: /\/v1(?:beta1)?$/u },
};

function assertProviderBody(provider: PlatformProvider, input: PlatformRequest): void {
  assertInferencePath(provider, input.request.method, input.request.path);
  if (provider === 'google' && input.request.contentType?.toLowerCase() === 'multipart/form-data')
    throw new Error('Google platform requests use JSON bodies');
}

function apiKeyTarget(projectRoot: string, input: PlatformRequest): PlatformTarget | undefined {
  for (const provider of ['openai', 'google'] as const) {
    let profile: ReturnType<typeof resolvePlatformApiKeyAccount>;
    try {
      profile = resolvePlatformApiKeyAccount(projectRoot, provider, input.accountRef);
    } catch {
      continue; // Not this provider's API key account.
    }
    const apiKey = profile?.apiKey;
    if (!profile || !apiKey || !/^\S+$/u.test(apiKey)) continue;
    assertProviderBody(provider, input);
    const wire = API_KEY_WIRE[provider];
    const base = platformAccountBaseUrl(profile, provider);
    const requested = new URL(input.request.path, base.origin);
    const url = new URL(base.href);
    url.pathname = base.pathname.replace(/\/+$/, '').replace(wire.version, '') + requested.pathname;
    url.search = requested.search;
    assertPlatformAccountDestination(profile, provider, url.href);
    return {
      provider,
      url: url.href,
      credentials: [apiKey, ...configuredCredentialValues()],
      authenticate(headers) {
        assertPlatformAccountDestination(profile, provider, url.href);
        headers.set(...wire.header(apiKey));
      },
    };
  }
  return undefined;
}

async function googleCloudTarget(
  projectRoot: string,
  input: PlatformRequest,
  transport: Transport,
): Promise<PlatformTarget | undefined> {
  let account: ReturnType<typeof resolveGoogleCloudPlatformAccount>;
  try {
    account = resolveGoogleCloudPlatformAccount(projectRoot, input.accountRef);
  } catch {
    return undefined;
  }
  if (!account) return undefined;
  assertProviderBody('google', input);
  const origin = googleCloudVertexOrigin(input.request.method, input.request.path, account.projectId);
  const url = new URL(input.request.path, origin);
  if (url.origin !== origin) throw new Error('Google Cloud destination differs from Vertex AI');
  // The owner's login is read and refreshed by the host only, never handed to the caller.
  const grant = readLocalAdc();
  const token = await exchangeGoogleCloudAccessToken(grant, transport.fetch, transport.signal);
  return {
    provider: 'google',
    url: url.href,
    credentials: [grant.refreshToken, grant.clientSecret, token, ...configuredCredentialValues()],
    authenticate(headers) {
      if (new URL(url.href).origin !== origin) throw new Error('Google Cloud destination differs from Vertex AI');
      headers.set('authorization', `Bearer ${token}`);
      headers.set('x-goog-user-project', account.projectId);
    },
  };
}

export async function resolvePlatformTarget(
  projectRoot: string,
  input: PlatformRequest,
  transport: Transport,
): Promise<PlatformTarget> {
  const target = apiKeyTarget(projectRoot, input) ?? (await googleCloudTarget(projectRoot, input, transport));
  if (target) return target;
  throw Object.assign(
    new Error(
      'Selected platform account is unavailable (OpenAI or Google API key, or Google Cloud login); check the Hub account configuration',
    ),
    { code: 'platform_account_unavailable' },
  );
}
