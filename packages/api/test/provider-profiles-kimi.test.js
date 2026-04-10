import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

test('accounts route accepts kimi api_key account creation', async () => {
  const Fastify = (await import('fastify')).default;
  const { accountsRoutes } = await import('../dist/routes/accounts.js');
  const app = Fastify();
  await app.register(accountsRoutes);
  await app.ready();

  const projectDir = await mkdtemp(join(tmpdir(), 'accounts-kimi-'));
  const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectDir;

  try {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        projectPath: projectDir,
        displayName: 'Moonshot',
        authType: 'api_key',
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKey: 'sk-kimi',
        models: ['kimi-k2.5'],
      }),
    });
    assert.equal(createRes.statusCode, 200, `create failed: ${createRes.body}`);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/accounts?projectPath=${encodeURIComponent(projectDir)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(listRes.statusCode, 200);
    const account = listRes.json().providers.find((entry) => entry.displayName === 'Moonshot');
    assert.ok(account, 'Kimi account should be listed');
    assert.equal(account.kind, 'api_key');
  } finally {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    await rm(projectDir, { recursive: true, force: true });
    await app.close();
  }
});
