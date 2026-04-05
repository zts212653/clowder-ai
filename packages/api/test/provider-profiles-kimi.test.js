import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

test('provider profiles infer kimi protocol from provider selector', async () => {
  const Fastify = (await import('fastify')).default;
  const { providerProfilesRoutes } = await import('../dist/routes/provider-profiles.js');
  const app = Fastify();
  await app.register(providerProfilesRoutes);
  await app.ready();

  const projectDir = await mkdtemp(join(tmpdir(), 'provider-profiles-kimi-'));
  const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectDir;

  try {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/provider-profiles',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        projectPath: projectDir,
        provider: 'kimi',
        displayName: 'Moonshot',
        authType: 'api_key',
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKey: 'sk-kimi',
        models: ['kimi-k2.5'],
      }),
    });
    assert.equal(createRes.statusCode, 200);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/provider-profiles?projectPath=${encodeURIComponent(projectDir)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(listRes.statusCode, 200);
    const profile = listRes.json().providers.find((entry) => entry.displayName === 'Moonshot');
    assert.ok(profile);
    assert.equal(profile.protocol, 'kimi');
  } finally {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    await rm(projectDir, { recursive: true, force: true });
    await app.close();
  }
});
