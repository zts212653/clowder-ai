import { describe, expect, it, vi } from 'vitest';

import { createGitHubHumanAuthProvider } from '../github-human-auth-provider.js';

describe('GitHubHumanAuthProvider', () => {
  it('is explicitly unavailable without complete OAuth configuration', () => {
    const provider = createGitHubHumanAuthProvider({});
    expect(provider.readiness).toEqual({ ready: false, reason: 'not_configured' });
    expect(() =>
      provider.authorizationUrl({
        state: 'opaque-state',
        redirectUri: 'https://collective.example/api/auth/github/callback',
      }),
    ).toThrow(/configured/i);
  });

  it('exchanges a code for a stable provider subject without retaining the access token', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'github-access-secret', token_type: 'bearer', scope: 'read:user' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 123456,
            login: 'operator',
            name: 'You',
            avatar_url: 'https://avatars.example/operator.png',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const provider = createGitHubHumanAuthProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetchImpl,
    });
    const redirectUri = 'https://collective.example/api/auth/github/callback';

    const authorization = new URL(provider.authorizationUrl({ state: 'opaque-state', redirectUri }));
    expect(authorization.origin + authorization.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorization.searchParams.get('state')).toBe('opaque-state');
    expect(authorization.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(authorization.searchParams.get('scope')).toBeNull();

    await expect(provider.authenticate({ code: 'one-time-code', redirectUri })).resolves.toEqual({
      providerSubject: '123456',
      handle: 'operator',
      displayName: 'You',
      avatarUrl: 'https://avatars.example/operator.png',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer github-access-secret' }) }),
    );
    expect(JSON.stringify(provider)).not.toContain('github-access-secret');
  });

  it('fails closed on malformed GitHub identity responses', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'temporary-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'not-numeric', login: 'operator' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const provider = createGitHubHumanAuthProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetchImpl,
    });

    await expect(
      provider.authenticate({
        code: 'one-time-code',
        redirectUri: 'https://collective.example/api/auth/github/callback',
      }),
    ).rejects.toThrow(/identity/i);
  });
});
