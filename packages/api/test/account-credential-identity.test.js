import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  resolveAnthropicRuntimeProfile,
  resolveByAccountRef,
  resolveForClient,
  validateRuntimeProviderBinding,
} from '../dist/config/account-resolver.js';
import { resolveApiCredentials } from '../dist/domains/cats/services/agents/providers/catagent/catagent-credentials.js';

let root;
let saved;
let previousFetch;
let configs;
let calls;
const envKeys = ['CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_SKIP_HOMEDIR_MIGRATION'];
const fakeKey = 'FAKE_FOREIGN_KEY';
const put = (name, content) => writeFileSync(join(root, '.cat-cafe', name), JSON.stringify(content));
function seed(ref, account, key = fakeKey) {
  put('accounts.json', { [ref]: account });
  put('credentials.json', { [ref]: { apiKey: key } });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'credential-identity-'));
  mkdirSync(join(root, '.cat-cafe'));
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION = '1';
  configs = catRegistry.getAllConfigs();
  previousFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({
      content: [{ text: 'fixture' }],
      choices: [{ message: { content: 'fixture' } }],
      candidates: [{ content: { parts: [{ text: 'fixture' }] } }],
    });
  };
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  catRegistry.reset();
  for (const [id, config] of Object.entries(configs)) catRegistry.register(id, config);
  rmSync(root, { recursive: true, force: true });
});

for (const authType of ['api_key', 'oauth', 'subscription']) {
  for (const clientId of ['acp', 'opencode']) {
    test(`${authType} ${clientId} transport cannot bypass an explicit official destination mismatch`, () => {
      seed('fixture', { authType, clientId: 'openai', baseUrl: 'https://api.anthropic.com' });
      const profile = resolveByAccountRef(root, 'fixture');
      assert.match(validateRuntimeProviderBinding(clientId, profile, 'fixture-model'), /identity.*incompatible/i);
    });
  }
  test(`${authType} CatAgent credentials cannot send an OpenAI key to Anthropic`, () => {
    seed('fixture', { authType, clientId: 'openai' });
    assert.throws(
      () => resolveApiCredentials(root, 'opus', { accountRef: 'fixture' }),
      /identity|family|incompatible/i,
    );
    assert.equal(calls.length, 0);
    assert.throws(() => resolveAnthropicRuntimeProfile(root, 'fixture'), /identity|family|incompatible/i);
  });
  test(`${authType} ACP carrier rejects a foreign account before creating a process pool`, async () => {
    const { createAcpServiceForConfig } = await import(
      '../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
    );
    seed('fixture', { authType, clientId: 'openai' });
    const poolRegistry = new Map();
    try {
      const service = await createAcpServiceForConfig({
        projectRoot: root,
        bootstrapRoot: join(root, 'bootstrap'),
        profileId: 'identity-acp',
        effectiveModel: 'fixture-model',
        config: { ...configs.opus, id: 'identity-acp', clientId: 'anthropic', accountRef: 'fixture' },
        acpConfig: { command: 'mock-acp', startupArgs: ['--acp'] },
        poolRegistry,
        log: { info() {}, warn() {} },
      });
      assert.equal(service, null);
      assert.equal(poolRegistry.size, 0);
    } finally {
      await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll()));
    }
  });
}

test('legacy subscription has OpenAI identity and remains eligible for a same-family binding', () => {
  seed('openai', { authType: 'subscription' });
  const profile = resolveByAccountRef(root, 'openai');
  assert.equal(profile.authType, 'oauth');
  assert.equal(profile.client, 'openai');
  assert.equal(validateRuntimeProviderBinding('openai', profile), null);
  assert.match(validateRuntimeProviderBinding('anthropic', profile), /identity|family|incompatible/i);
});

test('implicit discovery never returns a foreign key through a builtin alias', () => {
  seed('claude', { authType: 'api_key', clientId: 'openai' });
  const profile = resolveForClient(root, 'anthropic');
  assert.notEqual(profile?.apiKey, fakeKey);
});

test('custom API key creation requires identity and cannot occupy a builtin slug', async () => {
  const Fastify = (await import('fastify')).default;
  const { accountsRoutes } = await import('../dist/routes/accounts.js');
  const app = Fastify();
  await app.register(accountsRoutes);
  const headers = { 'x-cat-cafe-user': 'fixture-owner' };
  try {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers,
      payload: { displayName: 'claude', authType: 'api_key', apiKey: fakeKey },
    });
    assert.equal(missing.statusCode, 400, missing.body);
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers,
      payload: { displayName: 'claude', authType: 'api_key', clientId: 'openai', apiKey: fakeKey },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.notEqual(created.json().profile.id, 'claude');
    assert.equal(created.json().profile.clientId, 'openai');
  } finally {
    await app.close();
  }
});

test('JavaScript prototype properties are not synthetic builtin accounts', () => {
  for (const ref of ['constructor', 'toString', '__proto__']) assert.equal(resolveByAccountRef(root, ref), null);
});
