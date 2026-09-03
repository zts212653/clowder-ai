import { z } from 'zod';

import { CollectiveServiceError } from './errors.js';
import type { ExternalHumanIdentity, HumanAuthProvider } from './human-auth-provider.js';

const tokenResponseSchema = z.object({ access_token: z.string().min(1) }).passthrough();
const userResponseSchema = z
  .object({
    id: z.number().int().positive(),
    login: z.string().trim().min(1).max(160),
    name: z.string().trim().min(1).max(160).nullable().optional(),
    avatar_url: z.string().url().optional(),
  })
  .passthrough();

export interface GitHubHumanAuthProviderOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createGitHubHumanAuthProvider(options: GitHubHumanAuthProviderOptions): HumanAuthProvider {
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret?.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const ready = Boolean(clientId && clientSecret);
  return {
    id: 'github',
    readiness: ready ? { ready: true } : { ready: false, reason: 'not_configured' },
    authorizationUrl({ state, redirectUri }) {
      const configuration = requireConfiguration(clientId, clientSecret);
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', configuration.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },
    async authenticate({ code, redirectUri }): Promise<ExternalHumanIdentity> {
      const configuration = requireConfiguration(clientId, clientSecret);
      const tokenResponse = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'collective-service',
        },
        body: new URLSearchParams({
          client_id: configuration.clientId,
          client_secret: configuration.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenResponse.ok) throw upstreamFailure('GitHub token exchange failed');
      const token = tokenResponseSchema.safeParse(await tokenResponse.json());
      if (!token.success) throw upstreamFailure('GitHub token exchange returned an invalid response');
      const userResponse = await fetchImpl('https://api.github.com/user', {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token.data.access_token}`,
          'user-agent': 'collective-service',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!userResponse.ok) throw upstreamFailure('GitHub identity lookup failed');
      const user = userResponseSchema.safeParse(await userResponse.json());
      if (!user.success) throw upstreamFailure('GitHub identity response is invalid');
      return {
        providerSubject: String(user.data.id),
        handle: user.data.login,
        displayName: user.data.name ?? user.data.login,
        ...(user.data.avatar_url ? { avatarUrl: user.data.avatar_url } : {}),
      };
    },
  };
}

function requireConfiguration(
  clientId: string | undefined,
  clientSecret: string | undefined,
): { readonly clientId: string; readonly clientSecret: string } {
  if (!clientId || !clientSecret) {
    throw new CollectiveServiceError('AUTH_PROVIDER_NOT_READY', 'GitHub Human auth is not configured', 503);
  }
  return { clientId, clientSecret };
}

function upstreamFailure(message: string): CollectiveServiceError {
  return new CollectiveServiceError('AUTH_IDENTITY_INVALID', message, 502);
}
