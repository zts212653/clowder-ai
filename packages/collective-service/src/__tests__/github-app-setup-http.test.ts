import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareGitHubAppManifestSubmission } from '@cat-cafe/collective-client';
import { afterEach, expect, it } from 'vitest';
import { GitHubAppManifestSetup } from '../github-app-manifest-setup.js';
import { ConfigurableGitHubHumanAuthProvider } from '../github-human-auth-provider.js';
import { type RunningCollectiveServer, startCollectiveServer } from '../http-server.js';
import { CollectiveServiceStore } from '../store.js';

let server: RunningCollectiveServer | undefined;
let dataDirectory: string | undefined;

afterEach(async () => {
  await server?.close();
  if (dataDirectory) await rm(dataDirectory, { recursive: true });
  server = undefined;
  dataDirectory = undefined;
});

it('lets the bootstrap holder create the GitHub App without receiving its generated secret', async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'collective-http-github-app-'));
  const provider = new ConfigurableGitHubHumanAuthProvider({});
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider: provider,
    humanAuthRedirectUri: 'http://127.0.0.1/api/auth/github/callback',
  });
  const setup = await GitHubAppManifestSetup.open({
    dataDirectory,
    provider,
    createSecret: () => 'm'.repeat(43),
    fetchImpl: async () =>
      new Response(JSON.stringify({ id: 7, client_id: 'generated-id', client_secret: 'generated-secret' }), {
        status: 201,
      }),
  });
  server = await startCollectiveServer({
    store: opened.store,
    host: '127.0.0.1',
    port: 0,
    githubAppSetup: setup,
  });

  const providersBefore = await get('/api/auth/providers');
  expect(providersBefore.providers).toEqual([
    { id: 'github', ready: false, reason: 'not_configured', setupSupported: true },
  ]);
  expect((await post('/api/setup/github-app/begin', { bootstrapSecret: 'wrong-secret' })).status).toBe(401);

  const beginResponse = await post('/api/setup/github-app/begin', { bootstrapSecret: opened.bootstrapSecret });
  expect(beginResponse.status).toBe(201);
  const begin = (await beginResponse.json()) as Record<string, unknown>;
  expect(begin.registrationUrl).toBe(`https://github.com/settings/apps/new?state=${'m'.repeat(43)}`);
  const submission = prepareGitHubAppManifestSubmission(begin);
  expect(submission.action).toBe(`https://github.com/settings/apps/new?state=${'m'.repeat(43)}`);
  expect(submission.method).toBe('post');
  expect(submission.fields).toHaveLength(1);
  expect(submission.fields[0]?.name).toBe('manifest');
  expect(JSON.parse(submission.fields[0]?.value ?? '')).toEqual({
    name: expect.stringMatching(/^Collective Service /),
    url: 'http://127.0.0.1',
    redirect_url: 'http://127.0.0.1/api/setup/github-app/callback',
    callback_urls: ['http://127.0.0.1/api/auth/github/callback'],
    public: true,
  });
  expect(JSON.stringify(begin)).not.toContain('generated-secret');

  const callback = await fetch(
    `${server.url}/api/setup/github-app/callback?state=${'m'.repeat(43)}&code=manifest-code`,
    { redirect: 'manual' },
  );
  expect(callback.status).toBe(303);
  expect(callback.headers.get('location')).toBe('/?providerConfigured=1');
  expect((await get('/api/auth/providers')).providers).toEqual([{ id: 'github', ready: true, setupSupported: true }]);
});

function post(path: string, body: unknown) {
  return fetch(`${server?.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  const response = await fetch(`${server?.url}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}
