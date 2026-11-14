import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { AccountConfig } from '@cat-cafe/shared';
import Fastify from 'fastify';
import {
  resolveAnthropicPlatformAccount,
  resolveAnthropicRuntimeProfile,
  resolveForClient,
  validateRuntimeProviderBinding,
} from '../src/config/account-resolver.js';
import { assertProviderCredentialDestination } from '../src/config/provider-credential-policy.js';
import { buildProviderEndpoint } from '../src/config/provider-endpoint.js';
import { accountsRoutes } from '../src/routes/accounts.js';

let root: string;
let previous: string | undefined;
const platform = { clientId: 'anthropic', authType: 'api_key' } as const;
const resolvePlatform = (ref?: string) => resolveAnthropicPlatformAccount(root, ref);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anthropic-platform-'));
  previous = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  mkdirSync(join(root, '.cat-cafe'));
});
afterEach(() => {
  if (previous === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previous;
  rmSync(root, { recursive: true, force: true });
});
function store(accounts: Record<string, AccountConfig>, keys: Record<string, string>) {
  writeFileSync(join(root, '.cat-cafe/accounts.json'), JSON.stringify(accounts));
  writeFileSync(
    join(root, '.cat-cafe/credentials.json'),
    JSON.stringify(Object.fromEntries(Object.entries(keys).map(([id, apiKey]) => [id, { apiKey }]))),
  );
}
test('Anthropic model-free key uses the official destination and keeps Claude OAuth binding', () => {
  store({ shared: platform, claude: { clientId: 'anthropic', authType: 'oauth' } }, { shared: 'FAKE_ANTHROPIC' });
  const profile = resolvePlatform();
  assert.ok(profile);
  assert.equal(profile.id, 'shared');
  const endpoint = buildProviderEndpoint({ protocol: 'anthropic', baseUrl: profile.baseUrl });
  assert.equal(endpoint, 'https://api.anthropic.com/v1/messages');
  assert.equal(validateRuntimeProviderBinding('anthropic', profile, 'claude-fixture'), null);
  assert.doesNotThrow(() => assertProviderCredentialDestination(profile, 'anthropic', endpoint));
  assert.throws(() => assertProviderCredentialDestination(profile, 'anthropic', 'https://api.openai.com/v1/responses'));
  assert.equal(resolveAnthropicRuntimeProfile(root).mode, 'subscription');
  assert.equal(resolveAnthropicRuntimeProfile(root, 'shared').mode, 'api_key');
  assert.equal(resolveForClient(root, 'anthropic', 'claude')?.authType, 'oauth');
  for (const ref of ['claude', 'missing']) assert.throws(() => resolvePlatform(ref), /Anthropic Platform/);
});
test('Anthropic automatic lookup excludes gateways and is unique; explicit refs fail closed', () => {
  store(
    { a: platform, b: platform, empty: platform, foreign: { clientId: 'openai', authType: 'api_key' } },
    { a: 'FAKE_A', b: 'FAKE_B', foreign: 'FAKE_FOREIGN' },
  );
  assert.throws(() => resolvePlatform(), /Multiple Anthropic Platform accounts/);
  assert.equal(resolvePlatform('b')?.id, 'b');
  for (const ref of ['empty', 'foreign']) assert.throws(() => resolvePlatform(ref));
  store(
    {
      gateway: { ...platform, baseUrl: 'https://gateway.invalid' },
      insecure: { ...platform, baseUrl: 'http://api.anthropic.com' },
    },
    { gateway: 'FAKE_GATEWAY', insecure: 'FAKE_HTTP' },
  );
  assert.equal(resolvePlatform(), undefined);
  assert.equal(resolvePlatform('gateway')?.baseUrl, 'https://gateway.invalid');
});
test('name/key-only save and editing a pre-existing Anthropic key preserve legacy config, secret and cat catalog', async () => {
  store(
    {
      claude: { clientId: 'anthropic', authType: 'oauth' },
      old: { ...platform, baseUrl: 'https://api.anthropic.com', models: ['claude-fixture'] },
    },
    { old: 'FAKE_EXISTING_KEY' },
  );
  const catalog = JSON.stringify({ version: 2, breeds: [], selectedAccountRefs: { anthropic: 'claude' } });
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), catalog);
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const create = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, displayName: 'Shared Anthropic', ...platform, apiKey: 'FAKE_NEW_KEY' },
    });
    assert.equal(create.statusCode, 200, create.body);
    const id = create.json().profile.id;
    assert.equal(resolvePlatform(id)?.id, id);
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/accounts/old',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, displayName: 'Old renamed' },
    });
    assert.equal(update.statusCode, 200, update.body);
    const old = resolvePlatform('old');
    assert.equal(old?.baseUrl, 'https://api.anthropic.com');
    assert.deepEqual(old?.models, ['claude-fixture']);
    assert.equal(old?.apiKey, 'FAKE_EXISTING_KEY');
    assert.equal(update.body.includes('FAKE_EXISTING_KEY'), false);
    assert.equal(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'), catalog);
  } finally {
    await app.close();
  }
});
