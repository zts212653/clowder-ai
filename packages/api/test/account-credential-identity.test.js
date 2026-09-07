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
import { LlmAIProvider } from '../dist/domains/cats/services/game/LlmAIProvider.js';

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
function npc(clientId, accountRef) {
  const id = `identity-${clientId}`;
  if (catRegistry.tryGet(id)) return new LlmAIProvider(id);
  const { accountRef: _oldRef, ...template } = configs.opus;
  catRegistry.register(id, {
    ...template,
    id,
    clientId,
    defaultModel: 'fixture-model',
    mentionPatterns: [`@${id}`],
    ...(accountRef ? { accountRef } : {}),
  });
  return new LlmAIProvider(id);
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
  for (const bound of [false, true]) {
    test(`${authType} foreign key under claude ref is rejected before game fetch (bound=${bound})`, async () => {
      seed('claude', { authType, clientId: 'openai' });
      await assert.rejects(
        () => npc('anthropic', bound ? 'claude' : undefined).generateSpeech('fixture'),
        /identity|family|incompatible/i,
      );
      assert.equal(calls.length, 0);
    });
  }
  test(`${authType} foreign official endpoint cannot receive a same-client key`, async () => {
    seed('fixture', { authType, clientId: 'anthropic', baseUrl: 'https://api.openai.com/v1' });
    await assert.rejects(() => npc('anthropic', 'fixture').generateSpeech('fixture'), /identity|family|incompatible/i);
    assert.equal(calls.length, 0);
  });
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

for (const clientId of ['anthropic', 'openai', 'google', 'kimi']) {
  test(`${clientId} game honors an explicit gateway and keeps its query/hash`, async () => {
    seed('gateway', { authType: 'api_key', clientId, baseUrl: 'https://gateway.invalid/v1?tenant=a#fragment' });
    assert.equal(await npc(clientId, 'gateway').generateSpeech('fixture'), 'fixture');
    const url = new URL(calls[0].url);
    assert.equal(url.origin, 'https://gateway.invalid');
    assert.equal(url.searchParams.get('tenant'), 'a');
    assert.equal(url.hash, '#fragment');
    assert.equal(calls[0].init.redirect, 'error', 'a gateway redirect must not forward the key to another origin');
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

test('unknown legacy identity is allowed only at an explicit third-party gateway', async () => {
  seed('custom', { authType: 'api_key' });
  await assert.rejects(() => npc('anthropic', 'custom').generateSpeech('fixture'), /identity|family/i);
  assert.equal(calls.length, 0);
  seed('custom', { authType: 'api_key', baseUrl: 'https://gateway.invalid' });
  assert.equal(await npc('anthropic', 'custom').generateSpeech('fixture'), 'fixture');
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

for (const hostname of ['API.ANTHROPIC.COM', 'api.anthropic.com.', 'nested.api.anthropic.com']) {
  test(`official hostname normalization blocks foreign identity at ${hostname}`, async () => {
    seed('custom', { authType: 'oauth', clientId: 'openai', baseUrl: `https://${hostname}` });
    await assert.rejects(() => npc('anthropic', 'custom').generateSpeech('fixture'), /identity|incompatible/i);
    assert.equal(calls.length, 0);
  });
}

for (const clientId of ['anthropic', 'openai', 'google', 'kimi']) {
  test(`${clientId} positive identity can call its official endpoint`, async () => {
    seed('fixture', { authType: 'api_key', clientId });
    assert.equal(await npc(clientId, 'fixture').generateSpeech('fixture'), 'fixture');
    assert.equal(calls.length, 1);
  });
}

test('explicit cross-protocol gateway credentials retain their declared identity', async () => {
  seed('gateway', { authType: 'api_key', clientId: 'openai', baseUrl: 'https://gateway.invalid' });
  assert.equal(await npc('anthropic', 'gateway').generateSpeech('fixture'), 'fixture');
  assert.equal(resolveByAccountRef(root, 'gateway').client, 'openai');
});

test('Kimi key can use its official OpenAI-compatible API without being relabeled OpenAI', async () => {
  seed('gateway', { authType: 'api_key', clientId: 'kimi', baseUrl: 'https://api.moonshot.ai/v1' });
  assert.equal(await npc('openai', 'gateway').generateSpeech('fixture'), 'fixture');
  assert.equal(calls[0].url, 'https://api.moonshot.ai/v1/chat/completions');
});

test('explicit transport identity never falls back to a builtin name', async () => {
  seed('claude', { authType: 'oauth', clientId: 'acp' });
  await assert.rejects(() => npc('anthropic', 'claude').generateSpeech('fixture'), /identity|incompatible/i);
  assert.equal(calls.length, 0);
});

test('JavaScript prototype properties are not synthetic builtin accounts', () => {
  for (const ref of ['constructor', 'toString', '__proto__']) assert.equal(resolveByAccountRef(root, ref), null);
});

for (const baseUrl of ['file:///tmp/fixture', 'https://name:FAKE_PASSWORD@gateway.invalid/v1']) {
  test(`invalid destination is rejected before game fetch: ${baseUrl.split(':')[0]}`, async () => {
    seed('fixture', { authType: 'api_key', clientId: 'anthropic', baseUrl });
    await assert.rejects(
      () => npc('anthropic', 'fixture').generateSpeech('fixture'),
      (error) => {
        assert.match(error.message, /HTTP\(S\)|userinfo/i);
        assert.ok(!error.message.includes('FAKE_PASSWORD'));
        assert.ok(!error.message.includes(fakeKey));
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });
}

test('unbound game calls do not discover installer credentials when builtin has no API key', async () => {
  seed('installer-anthropic', { authType: 'api_key', clientId: 'anthropic' });
  await assert.rejects(() => npc('anthropic').generateSpeech('fixture'), /No .* API key/);
  assert.equal(calls.length, 0);
});
