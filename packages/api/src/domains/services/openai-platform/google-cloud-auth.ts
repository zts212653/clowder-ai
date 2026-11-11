import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleCloudGrant {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

const unavailable = () =>
  Object.assign(
    new Error(
      'Google Cloud login on this machine is unavailable; the owner can renew it with `gcloud auth application-default login`',
    ),
    { code: 'platform_account_unavailable' },
  );

/** Standard Application Default Credentials location, as Google's own clients resolve it. */
export function localAdcPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (explicit) return explicit;
  return join(env.CLOUDSDK_CONFIG?.trim() || join(home, '.config', 'gcloud'), 'application_default_credentials.json');
}

const usable = (value: unknown): value is string => typeof value === 'string' && /^\S+$/u.test(value);

/** Only the owner's own authorized-user login; service-account keys and federated configs are not used. */
export function readLocalAdc(path = localAdcPath()): GoogleCloudGrant {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw unavailable();
  }
  const { type, client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken } = value ?? {};
  if (type !== 'authorized_user' || !usable(clientId) || !usable(clientSecret) || !usable(refreshToken))
    throw unavailable();
  return { clientId, clientSecret, refreshToken };
}

/** One refresh at Google's token endpoint; the access token lives only for this request. */
export async function exchangeGoogleCloudAccessToken(
  grant: GoogleCloudGrant,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  let token: unknown;
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: grant.clientId,
        client_secret: grant.clientSecret,
        refresh_token: grant.refreshToken,
      }).toString(),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    token = ((await response.json()) as { access_token?: unknown }).access_token;
  } catch (error) {
    signal.throwIfAborted();
    throw (error as { code?: string })?.code === 'platform_account_unavailable' ? error : unavailable();
  }
  if (!usable(token)) throw unavailable();
  return token;
}
