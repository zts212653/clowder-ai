import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { AccountConfig } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { resolveForClient, resolveGooglePlatformAccount } from '../src/config/account-resolver.js';
import { assertProviderCredentialDestination } from '../src/config/provider-credential-policy.js';
import { buildProviderEndpoint } from '../src/config/provider-endpoint.js';
import { accountsRoutes } from '../src/routes/accounts.js';

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'google-platform-'));
  previousRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  mkdirSync(join(root, '.cat-cafe'));
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});
function store(accounts: Record<string, AccountConfig>, keys: Record<string, string>) {
  writeFileSync(join(root, '.cat-cafe/accounts.json'), JSON.stringify(accounts));
  writeFileSync(
    join(root, '.cat-cafe/credentials.json'),
    JSON.stringify(Object.fromEntries(Object.entries(keys).map(([ref, apiKey]) => [ref, { apiKey }]))),
  );
}
const platform = { clientId: 'google', authType: 'api_key' } as const;

test('Google Platform selects a named key and official default while existing Gemini OAuth keeps its identity', () => {
  store({ studio: platform, gemini: { clientId: 'google', authType: 'oauth' } }, { studio: 'FAKE_GOOGLE_KEY' });
  const profile = resolveGooglePlatformAccount(root);
  assert.ok(profile);
  assert.equal(profile.id, 'studio');
  assert.equal(profile.apiKey, 'FAKE_GOOGLE_KEY');
  const endpoint = buildProviderEndpoint({ protocol: 'google', baseUrl: profile.baseUrl, model: 'fixture-model' });
  assert.equal(endpoint, 'https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent');
  assert.doesNotThrow(() => assertProviderCredentialDestination(profile, 'google', endpoint));
  assert.throws(() => assertProviderCredentialDestination(profile, 'google', 'https://api.openai.com/v1/responses'));
  assert.equal(resolveForClient(root, 'google', 'gemini')?.authType, 'oauth');
  for (const ref of ['gemini', 'missing']) assert.throws(() => resolveGooglePlatformAccount(root, ref));
});
test('Google explicit identity fails closed; auto selection is unique and official while gateways require an explicit ref', () => {
  store(
    { a: platform, b: platform, empty: platform, foreign: { clientId: 'openai', authType: 'api_key' } },
    { a: 'FAKE_A', b: 'FAKE_B', foreign: 'FAKE_FOREIGN' },
  );
  assert.throws(() => resolveGooglePlatformAccount(root), /Multiple/);
  assert.equal(resolveGooglePlatformAccount(root, 'b')?.id, 'b');
  for (const ref of ['empty', 'foreign']) assert.throws(() => resolveGooglePlatformAccount(root, ref));
  store({ gateway: { ...platform, baseUrl: 'https://gateway.invalid' } }, { gateway: 'FAKE_GATEWAY' });
  assert.equal(resolveGooglePlatformAccount(root), undefined);
  assert.equal(resolveGooglePlatformAccount(root, 'gateway')?.id, 'gateway');
});
test('saving Google name and key alone persists the shared account without changing Gemini login or bindings', async () => {
  store({ gemini: { clientId: 'google', authType: 'oauth' } }, {});
  const catalog = JSON.stringify({ version: 2, breeds: [], selectedAccountRefs: { google: 'gemini' } });
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), catalog);
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, displayName: 'Google shared', ...platform, apiKey: 'FAKE_GOOGLE_KEY' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().profile.hasApiKey, true);
    assert.equal(response.body.includes('FAKE_GOOGLE_KEY'), false);
    assert.equal(resolveGooglePlatformAccount(root)?.id, response.json().profile.id);
    assert.equal(resolveForClient(root, 'google', 'gemini')?.authType, 'oauth');
    assert.equal(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'), catalog);
  } finally {
    await app.close();
  }
});
