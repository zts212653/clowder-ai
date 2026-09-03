import { describe, expect, it } from 'vitest';

import { entryModeFromHash, humanAuthErrorMessage, phaseForHuman, trustedHumanAuthResult } from '../human-auth-flow.js';

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
});
