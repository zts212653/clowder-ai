import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('createGitHubSelfLoginResolver', () => {
  it('refreshes cached self login when the GitHub token fingerprint changes', async () => {
    const { createGitHubSelfLoginResolver } = await import('../dist/infrastructure/github/self-login-resolver.js');
    let tokenFingerprint = 'token-a';
    let calls = 0;
    const logins = new Map([
      ['token-a', 'alice'],
      ['token-b', 'bob'],
    ]);

    const resolver = createGitHubSelfLoginResolver({
      getTokenFingerprint: () => tokenFingerprint,
      resolveLogin: async () => {
        calls += 1;
        return logins.get(tokenFingerprint);
      },
    });

    assert.equal(resolver.getCurrent(), undefined);
    assert.equal(await resolver.refreshIfNeeded(), 'alice');
    assert.equal(resolver.getCurrent(), 'alice');
    assert.equal(await resolver.refreshIfNeeded(), 'alice');
    assert.equal(calls, 1, 'unchanged token should reuse cached login');

    tokenFingerprint = 'token-b';
    assert.equal(await resolver.refreshIfNeeded(), 'bob');
    assert.equal(resolver.getCurrent(), 'bob');
    assert.equal(calls, 2, 'changed token should resolve login again');
  });

  it('uses configured self login synchronously and does not call GitHub', async () => {
    const { createGitHubSelfLoginResolver } = await import('../dist/infrastructure/github/self-login-resolver.js');
    let configuredLogin = 'manual';
    let calls = 0;

    const resolver = createGitHubSelfLoginResolver({
      getConfiguredLogin: () => configuredLogin,
      getTokenFingerprint: () => 'token',
      resolveLogin: async () => {
        calls += 1;
        return 'from-gh';
      },
    });

    assert.equal(resolver.getCurrent(), 'manual');
    assert.equal(await resolver.refreshIfNeeded(), 'manual');
    assert.equal(calls, 0);

    configuredLogin = 'manual-next';
    assert.equal(resolver.getCurrent(), 'manual-next');
    assert.equal(await resolver.refreshIfNeeded(), 'manual-next');
    assert.equal(calls, 0);
  });

  it('drops stale cached login when a changed token cannot resolve a login', async () => {
    const { createGitHubSelfLoginResolver } = await import('../dist/infrastructure/github/self-login-resolver.js');
    let tokenFingerprint = 'token-a';

    const resolver = createGitHubSelfLoginResolver({
      getTokenFingerprint: () => tokenFingerprint,
      resolveLogin: async () => (tokenFingerprint === 'token-a' ? 'alice' : undefined),
    });

    assert.equal(await resolver.refreshIfNeeded(), 'alice');

    tokenFingerprint = 'token-b';
    assert.equal(await resolver.refreshIfNeeded(), undefined);
    assert.equal(resolver.getCurrent(), undefined);
  });

  it('does not let a stale in-flight refresh overwrite the latest token login', async () => {
    const { createGitHubSelfLoginResolver } = await import('../dist/infrastructure/github/self-login-resolver.js');
    let tokenFingerprint = 'token-a';
    const pending = new Map();

    const resolver = createGitHubSelfLoginResolver({
      getTokenFingerprint: () => tokenFingerprint,
      resolveLogin: async () => {
        const resolvingToken = tokenFingerprint;
        return new Promise((resolve) => pending.set(resolvingToken, resolve));
      },
    });

    const first = resolver.refreshIfNeeded();
    tokenFingerprint = 'token-b';
    const second = resolver.refreshIfNeeded();

    pending.get('token-b')('bob');
    assert.equal(await second, 'bob');
    assert.equal(resolver.getCurrent(), 'bob');

    pending.get('token-a')('alice');
    assert.equal(await first, 'bob');
    assert.equal(resolver.getCurrent(), 'bob');
  });
});
