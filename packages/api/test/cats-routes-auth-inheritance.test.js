import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { resolveByAccountRef } from '../dist/config/account-resolver.js';
import { _resetCachedConfig, loadCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import { catsRoutes } from '../dist/routes/cats.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

async function fixture(t, apiKey) {
  const restoreAuth = isolateAccountAuthEnvironment();
  const roots = ['CAT_TEMPLATE_PATH', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_CAFE_CONFIG_ROOT'];
  const previous = new Map(roots.map((key) => [key, process.env[key]]));
  t.after(() => {
    restoreAuth();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCachedConfig();
    catRegistry.reset();
    for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig()))) catRegistry.register(id, config);
  });
  // The preloader's template is an isolated copy of the repository template.
  const template = JSON.parse(readFileSync(process.env.CAT_TEMPLATE_PATH, 'utf8'));
  const root = mkdtempSync(join(tmpdir(), 'cats-auth-inheritance-'));
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(template));
  writeFileSync(join(root, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(template));
  process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  if (apiKey !== undefined) process.env.ANTHROPIC_API_KEY = apiKey;
  _resetCachedConfig();
  const app = Fastify();
  t.after(() => app.close());
  await app.register(catsRoutes);
  return { app, root };
}
const headers = { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' };
function body(catId, clientId) {
  return {
    catId,
    name: catId,
    displayName: catId,
    avatar: '/avatars/runtime.png',
    color: { primary: '#0f172a', secondary: '#e2e8f0' },
    mentionPatterns: [`@${catId}`],
    roleDescription: 'Fixture role',
    clientId,
    accountRef: 'claude',
    defaultModel: 'claude-sonnet-4-6',
  };
}

it('POST /api/cats rejects builtin bindings from the wrong client family even when protocol matches', async (t) => {
  const { app, root } = await fixture(t);
  const account = resolveByAccountRef(root, 'claude');
  assert.equal(account.authType, 'oauth');
  assert.equal(account.syntheticNative, true);
  const res = await app.inject({
    method: 'POST',
    url: '/api/cats',
    headers,
    payload: body('wrong-family', 'opencode'),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error, /incompatible with client "opencode"/i);
});

it('POST /api/cats accepts the matching builtin OAuth client with no ambient API key', async (t) => {
  const { app } = await fixture(t);
  const res = await app.inject({
    method: 'POST',
    url: '/api/cats',
    headers,
    payload: body('oauth-family', 'anthropic'),
  });
  assert.equal(res.statusCode, 201, res.body);
});

it('POST and PATCH /api/cats preserve synthetic API-key inheritance for a compatible client', async (t) => {
  const key = 'fixture-key-never-used-for-a-call';
  const { app, root } = await fixture(t, key);
  const account = resolveByAccountRef(root, 'claude');
  assert.equal(account.authType, 'api_key');
  assert.equal(account.syntheticNative, true);
  assert.equal(account.protocol, 'anthropic');
  assert.equal(account.apiKey, key);
  const res = await app.inject({
    method: 'POST',
    url: '/api/cats',
    headers,
    payload: body('key-inheritance', 'opencode'),
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().cat.accountRef, 'claude');
  const updated = await app.inject({
    method: 'PATCH',
    url: '/api/cats/key-inheritance',
    headers,
    payload: { accountRef: 'claude', defaultModel: 'claude-sonnet-4-6' },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(resolveByAccountRef(root, 'claude').apiKey, key);
});

it('POST /api/cats still rejects an incompatible client with an inherited API key', async (t) => {
  const { app } = await fixture(t, 'fixture-key-never-used-for-a-call');
  const res = await app.inject({
    method: 'POST',
    url: '/api/cats',
    headers,
    payload: body('wrong-protocol', 'openai'),
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error, /identity is incompatible with openai/i);
});
