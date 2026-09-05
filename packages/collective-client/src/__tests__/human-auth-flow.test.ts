import { describe, expect, it } from 'vitest';

import { prepareGitHubAppManifestSubmission } from '../github-app-manifest.js';
import {
  entryModeFromHash,
  humanAuthErrorMessage,
  phaseForHuman,
  trustedGitHubAppRegistrationUrl,
  trustedHumanAuthResult,
  trustedProviderSetupResult,
} from '../human-auth-flow.js';

describe('Collective Human auth flow', () => {
  it('lets bootstrap create the first steward before requiring a provider binding', () => {
    const bootstrapOwner = {
      human: { humanId: 'human_owner', displayName: 'You', createdAt: '2026-08-29T00:00:00.000Z' },
      auth: null,
      collectives: [],
    };
    expect(phaseForHuman(bootstrapOwner)).toBe('create-collective');
    expect(
      phaseForHuman({
        ...bootstrapOwner,
        collectives: [
          {
            collectiveId: 'col_home',
            name: 'Clowder AI Collective',
            createdByHumanId: 'human_owner',
            createdAt: '2026-08-29T00:00:00.000Z',
            role: 'steward' as const,
          },
        ],
      }),
    ).toBe('bind-identity');
  });

  it('opens creation only for an authenticated Human and then the shared scene', () => {
    const authenticated = {
      human: { humanId: 'human_owner', displayName: 'You', createdAt: '2026-08-29T00:00:00.000Z' },
      auth: { provider: 'github' as const, handle: 'operator' },
      collectives: [],
    };
    expect(phaseForHuman(authenticated)).toBe('create-collective');
    expect(
      phaseForHuman({
        ...authenticated,
        collectives: [
          {
            collectiveId: 'col_home',
            name: 'Clowder AI Collective',
            createdByHumanId: 'human_owner',
            createdAt: '2026-08-29T00:00:00.000Z',
            role: 'steward' as const,
          },
        ],
      }),
    ).toBe('ready');
  });

  it('distinguishes one-time bootstrap and invitation links without inventing identity', () => {
    expect(entryModeFromHash('#bootstrap=once')).toBe('bootstrap');
    expect(entryModeFromHash('#invite=member')).toBe('invite');
    expect(entryModeFromHash('')).toBe('missing');
  });

  it('accepts a one-time popup completion only from the exact Service window and origin', () => {
    const authWindow = {};
    const completion = {
      type: 'collective:human-auth-completion',
      serviceUrl: 'http://localhost:5201',
      sessionToken: 'session-token-at-least-16',
    } as const;

    expect(
      trustedHumanAuthResult(
        { origin: 'http://localhost:5201', source: authWindow, data: completion },
        'http://localhost:5201',
        authWindow,
      ),
    ).toEqual(completion);
    expect(
      trustedHumanAuthResult(
        { origin: 'http://malicious.invalid', source: authWindow, data: completion },
        'http://localhost:5201',
        authWindow,
      ),
    ).toBeUndefined();
    expect(
      trustedHumanAuthResult(
        {
          origin: 'http://localhost:5201',
          source: authWindow,
          data: { ...completion, completionToken: 'must-never-leave-http-only-cookie' },
        },
        'http://localhost:5201',
        authWindow,
      ),
    ).toBeUndefined();
    expect(
      trustedHumanAuthResult(
        { origin: 'http://localhost:5201', source: {}, data: completion },
        'http://localhost:5201',
        authWindow,
      ),
    ).toBeUndefined();
    expect(
      trustedHumanAuthResult(
        {
          origin: 'http://localhost:5201',
          source: authWindow,
          data: { ...completion, sessionToken: '' },
        },
        'http://localhost:5201',
        authWindow,
      ),
    ).toBeUndefined();
  });

  it('accepts only a bounded auth error from the exact popup and maps it to product copy', () => {
    const authWindow = {};
    const denied = {
      type: 'collective:human-auth-error',
      serviceUrl: 'http://localhost:5201',
      errorCode: 'authorization_denied',
    } as const;

    expect(
      trustedHumanAuthResult(
        { origin: 'http://localhost:5201', source: authWindow, data: denied },
        'http://localhost:5201',
        authWindow,
      ),
    ).toEqual(denied);
    expect(humanAuthErrorMessage(denied.errorCode)).toBe('登录已取消；你可以留在这里，准备好后再试');
    expect(
      trustedHumanAuthResult(
        {
          origin: 'http://localhost:5201',
          source: authWindow,
          data: { ...denied, errorCode: 'raw-provider-secret', detail: 'must not cross windows' },
        },
        'http://localhost:5201',
        authWindow,
      ),
    ).toBeUndefined();
  });

  it('accepts provider setup completion only from the exact Service popup and origin', () => {
    const setupWindow = {};
    const completion = {
      type: 'collective:provider-setup-completion',
      serviceUrl: 'http://localhost:5201',
    } as const;

    expect(
      trustedProviderSetupResult(
        { origin: 'http://localhost:5201', source: setupWindow, data: completion },
        'http://localhost:5201',
        setupWindow,
      ),
    ).toEqual(completion);
    expect(
      trustedProviderSetupResult(
        { origin: 'http://malicious.invalid', source: setupWindow, data: completion },
        'http://localhost:5201',
        setupWindow,
      ),
    ).toBeUndefined();
    expect(
      trustedProviderSetupResult(
        {
          origin: 'http://localhost:5201',
          source: setupWindow,
          data: { ...completion, clientSecret: 'must-never-cross-windows' },
        },
        'http://localhost:5201',
        setupWindow,
      ),
    ).toBeUndefined();
    expect(
      trustedProviderSetupResult(
        { origin: 'http://localhost:5201', source: {}, data: completion },
        'http://localhost:5201',
        setupWindow,
      ),
    ).toBeUndefined();
  });

  it('submits the manifest only to GitHub with one bounded CSRF state parameter', () => {
    const state = 's'.repeat(43);
    const registrationUrl = `https://github.com/settings/apps/new?state=${state}`;
    expect(trustedGitHubAppRegistrationUrl(registrationUrl)).toBe(registrationUrl);
    expect(
      trustedGitHubAppRegistrationUrl(`https://malicious.invalid/settings/apps/new?state=${state}`),
    ).toBeUndefined();
    expect(
      trustedGitHubAppRegistrationUrl(`https://github.com/settings/apps/new?state=${state}&return_to=malicious`),
    ).toBeUndefined();
    expect(trustedGitHubAppRegistrationUrl('https://github.com/settings/apps/new?state=short')).toBeUndefined();

    const manifest = {
      name: 'Collective Service 12345678',
      url: 'http://127.0.0.1:5201',
      redirect_url: 'http://127.0.0.1:5201/api/setup/github-app/callback',
      callback_urls: ['http://127.0.0.1:5201/api/auth/github/callback'],
      public: true,
    };
    const submission = prepareGitHubAppManifestSubmission({ registrationUrl, manifest });
    expect(submission).toEqual({
      action: registrationUrl,
      method: 'post',
      fields: [{ name: 'manifest', value: JSON.stringify(manifest) }],
    });
    expect(() => prepareGitHubAppManifestSubmission({ registrationUrl, manifest: JSON.stringify(manifest) })).toThrow(
      'GitHub 登录应用配置不完整',
    );
    expect(() =>
      prepareGitHubAppManifestSubmission({
        registrationUrl,
        manifest: { ...manifest, client_secret: 'must-never-cross-the-wire' },
      }),
    ).toThrow('GitHub 登录应用配置不完整');
  });
});
