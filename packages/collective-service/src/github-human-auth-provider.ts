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
  return new ConfigurableGitHubHumanAuthProvider(options);
}

export interface GitHubOAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export class ConfigurableGitHubHumanAuthProvider implements HumanAuthProvider {
  readonly id = 'github' as const;
  readonly #fetchImpl: typeof fetch;
  #configuration?: GitHubOAuthCredentials;

  constructor(options: GitHubHumanAuthProviderOptions) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.configureIfComplete(options);
  }

  get readiness() {
    return this.#configuration ? ({ ready: true } as const) : ({ ready: false, reason: 'not_configured' } as const);
  }

  configure(credentials: GitHubOAuthCredentials): void {
    const clientId = credentials.clientId.trim();
    const clientSecret = credentials.clientSecret.trim();
    if (!clientId || !clientSecret) {
      throw new CollectiveServiceError('AUTH_PROVIDER_NOT_READY', 'GitHub Human auth credentials are incomplete', 400);
    }
    this.#configuration = { clientId, clientSecret };
  }

  authorizationUrl({ state, redirectUri }: { readonly state: string; readonly redirectUri: string }): string {
    const configuration = this.requireConfiguration();
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', configuration.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async authenticate({
    code,
    redirectUri,
  }: {
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<ExternalHumanIdentity> {
    const configuration = this.requireConfiguration();
    const tokenResponse = await this.#fetchImpl('https://github.com/login/oauth/access_token', {
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
    const userResponse = await this.#fetchImpl('https://api.github.com/user', {
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
  }

  private configureIfComplete(options: GitHubHumanAuthProviderOptions): void {
    const clientId = options.clientId?.trim();
    const clientSecret = options.clientSecret?.trim();
    if (clientId && clientSecret) this.#configuration = { clientId, clientSecret };
  }

  private requireConfiguration(): GitHubOAuthCredentials {
    if (!this.#configuration) {
      throw new CollectiveServiceError('AUTH_PROVIDER_NOT_READY', 'GitHub Human auth is not configured', 503);
    }
    return this.#configuration;
  }
}

function upstreamFailure(message: string): CollectiveServiceError {
  return new CollectiveServiceError('AUTH_IDENTITY_INVALID', message, 502);
}
