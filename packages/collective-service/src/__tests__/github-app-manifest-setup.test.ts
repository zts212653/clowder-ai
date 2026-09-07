import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubAppManifestSetup } from '../github-app-manifest-setup.js';
import { ConfigurableGitHubHumanAuthProvider } from '../github-human-auth-provider.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('GitHub App Manifest setup', () => {
  it('converts a one-time manifest code and persists only OAuth credentials with private permissions', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-github-app-'));
    directories.push(dataDirectory);
    const provider = new ConfigurableGitHubHumanAuthProvider({});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 4242,
          client_id: 'generated-client-id',
          client_secret: 'generated-client-secret',
          pem: 'private-key-that-must-not-be-kept',
          webhook_secret: 'webhook-secret-that-must-not-be-kept',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    const setup = await GitHubAppManifestSetup.open({
      dataDirectory,
      provider,
      fetchImpl,
      now: () => Date.parse('2026-09-04T00:00:00.000Z'),
      createSecret: () => 's'.repeat(43),
    });

    const started = await setup.begin({
      serviceInstanceId: 'svc_1234567890abcdef',
      serviceUrl: 'http://127.0.0.1:5201',
      humanAuthCallbackUrl: 'http://127.0.0.1:5201/api/auth/github/callback',
      setupCallbackUrl: 'http://127.0.0.1:5201/api/setup/github-app/callback',
    });
    expect(started.registrationUrl).toBe(`https://github.com/settings/apps/new?state=${'s'.repeat(43)}`);
    expect(started.manifest.public).toBe(true);
    expect(started.manifest.callback_urls).toEqual(['http://127.0.0.1:5201/api/auth/github/callback']);
    expect(started.manifest.redirect_url).toBe('http://127.0.0.1:5201/api/setup/github-app/callback');
    expect(JSON.stringify(started.manifest)).not.toMatch(/secret|pem/i);

    await setup.complete({ state: 's'.repeat(43), code: 'one-hour-code' });

    expect(provider.readiness).toEqual({ ready: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/app-manifests/one-hour-code/conversions',
      expect.objectContaining({ method: 'POST' }),
    );
    const credentialPath = join(dataDirectory, 'github-app-oauth.json');
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(credentialPath, 'utf8');
    expect(persisted).toContain('generated-client-id');
    expect(persisted).toContain('generated-client-secret');
    expect(persisted).not.toContain('private-key-that-must-not-be-kept');
    expect(persisted).not.toContain('webhook-secret-that-must-not-be-kept');
    await expect(setup.complete({ state: 's'.repeat(43), code: 'replay-code' })).rejects.toMatchObject({
      code: 'GITHUB_APP_SETUP_CONSUMED',
    });
  });

  it('loads persisted credentials after a Service restart and rejects expired setup state before exchange', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-github-app-restart-'));
    directories.push(dataDirectory);
    let now = Date.parse('2026-09-04T00:00:00.000Z');
    const firstProvider = new ConfigurableGitHubHumanAuthProvider({});
    const setup = await GitHubAppManifestSetup.open({
      dataDirectory,
      provider: firstProvider,
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: 42, client_id: 'saved-id', client_secret: 'saved-secret' }), {
          status: 201,
        }),
      now: () => now,
      createSecret: () => 't'.repeat(43),
    });
    await setup.begin({
      serviceInstanceId: 'svc_restart',
      serviceUrl: 'http://127.0.0.1:5201',
      humanAuthCallbackUrl: 'http://127.0.0.1:5201/api/auth/github/callback',
      setupCallbackUrl: 'http://127.0.0.1:5201/api/setup/github-app/callback',
      ttlMs: 10,
    });
    now += 11;
    await expect(setup.complete({ state: 't'.repeat(43), code: 'expired' })).rejects.toMatchObject({
      code: 'GITHUB_APP_SETUP_EXPIRED',
    });

    now -= 11;
    const retry = await setup.begin({
      serviceInstanceId: 'svc_restart',
      serviceUrl: 'http://127.0.0.1:5201',
      humanAuthCallbackUrl: 'http://127.0.0.1:5201/api/auth/github/callback',
      setupCallbackUrl: 'http://127.0.0.1:5201/api/setup/github-app/callback',
    });
    const retryState = new URL(retry.registrationUrl).searchParams.get('state');
    expect(retryState).toBeTruthy();
    if (!retryState) throw new Error('Expected a setup state');
    await setup.complete({ state: retryState, code: 'ok' });

    const restartedProvider = new ConfigurableGitHubHumanAuthProvider({});
    await GitHubAppManifestSetup.open({ dataDirectory, provider: restartedProvider });
    expect(restartedProvider.readiness).toEqual({ ready: true });
  });

  it('claims a setup attempt before exchange so concurrent callback replay never reaches GitHub twice', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-github-app-concurrent-'));
    directories.push(dataDirectory);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 9, client_id: 'client-id', client_secret: 'client-secret' }), {
        status: 201,
      }),
    );
    const setup = await GitHubAppManifestSetup.open({
      dataDirectory,
      provider: new ConfigurableGitHubHumanAuthProvider({}),
      fetchImpl,
      createSecret: () => 'u'.repeat(43),
    });
    await setup.begin({
      serviceInstanceId: 'svc_concurrent',
      serviceUrl: 'http://127.0.0.1:5201',
      humanAuthCallbackUrl: 'http://127.0.0.1:5201/api/auth/github/callback',
      setupCallbackUrl: 'http://127.0.0.1:5201/api/setup/github-app/callback',
    });

    const results = await Promise.allSettled([
      setup.complete({ state: 'u'.repeat(43), code: 'first' }),
      setup.complete({ state: 'u'.repeat(43), code: 'replay' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
