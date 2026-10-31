import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { resolveForClient } from '../src/config/account-resolver.js';
import { readCredential } from '../src/config/credentials.js';
import { accountsRoutes } from '../src/routes/accounts.js';

let root: string;
let saved: NodeJS.ProcessEnv;
const headers = { 'x-cat-cafe-user': 'fixture' };
const tokenA = 'sk-ant-oat01-fixture-account-A';
const tokenB = 'sk-ant-oat01-fixture-account-B';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-claude-')));
  saved = { ...process.env };
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
async function create(app: ReturnType<typeof Fastify>, token = tokenA, name = '公司') {
  return app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers,
    payload: { projectPath: root, authType: 'oauth', clientId: 'anthropic', displayName: name, claudeToken: token },
  });
}
test('Claude token accounts persist separate secrets without claiming a verified login', async () => {
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const a = await create(app);
    const b = await create(app, tokenB, '私人');
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    const av = a.json().profile;
    const bv = b.json().profile;
    assert.equal(av.claudeTokenStatus, 'saved');
    assert.equal(av.claude.kind, 'long_lived_token');
    assert.equal(av.claude.identity, undefined);
    assert.notEqual(av.id, bv.id);
    assert.equal(readCredential(av.id, root)?.accessToken, tokenA);
    assert.equal(readCredential(bv.id, root)?.accessToken, tokenB);
    const list = await app.inject({ url: `/api/accounts?projectPath=${encodeURIComponent(root)}`, headers });
    for (const response of [a, b, list]) {
      assert.ok(!response.body.includes(tokenA));
      assert.ok(!response.body.includes(tokenB));
    }
    assert.ok(!readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8').includes(tokenA));
    const resolved = resolveForClient(root, 'anthropic', av.id)!;
    assert.equal(resolved.envVars?.CLAUDE_CODE_OAUTH_TOKEN, tokenA);
    assert.equal(resolved.envVars?.HOME, undefined);
    assert.equal(resolved.envVars?.CLAUDE_CONFIG_DIR, undefined);
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${av.id}`,
      headers,
      payload: { projectPath: root, displayName: '工作' },
    });
    assert.equal(rename.statusCode, 200, rename.body);
    assert.equal(readCredential(av.id, root)?.accessToken, tokenA);
    assert.equal(rename.json().profile.claudeTokenStatus, 'saved');
  } finally {
    await app.close();
  }
});
test('malformed secret never appears in validation errors or creates an account', async () => {
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const bad = 'secret-that-must-not-be-echoed';
    const response = await create(app, bad);
    assert.equal(response.statusCode, 400, response.body);
    assert.ok(!response.body.includes(bad));
  } finally {
    await app.close();
  }
});

test('local Claude binding is atomic, fences stale previews and updates only enabled local members', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { toAllCatConfigs } = await import('../src/config/cat-config-loader.js');
  const { readRuntimeAccountMembers, updateRuntimeCat } = await import('../src/config/runtime-cat-catalog.js');
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  process.env.CAT_CAFE_RUNTIME_ROOT = root;
  process.env.CAT_CAFE_WORKSPACE_ROOT = root;
  process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
  const variant = (id: string, clientId = 'anthropic') => ({
    id,
    catId: id,
    clientId,
    defaultModel: clientId === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-6.1-sol',
    accountRef: clientId === 'anthropic' ? 'claude' : 'codex',
    mcpSupport: true,
    cli: { command: clientId === 'anthropic' ? 'claude' : 'codex', outputFormat: 'json' },
  });
  const catalog = {
    version: 2,
    selectedAccountRefs: { anthropic: 'claude' },
    breeds: [
      {
        id: 'ragdoll',
        catId: 'opus',
        name: 'ragdoll',
        displayName: 'ragdoll',
        avatar: '/avatars/opus.png',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@opus'],
        roleDescription: 'fixture',
        defaultVariantId: 'opus',
        variants: [variant('opus'), variant('sonnet'), variant('sleepy'), variant('sol', 'openai')],
      },
    ],
    roster: Object.fromEntries(
      ['opus', 'sonnet', 'sleepy', 'sol'].map((id) => [
        id,
        { family: 'ragdoll', roles: ['assistant'], lead: false, available: id !== 'sleepy', evaluation: 'fixture' },
      ]),
    ),
    reviewPolicy: {
      requireDifferentFamily: false,
      preferActiveInThread: false,
      preferLead: false,
      excludeUnavailable: true,
    },
  };
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(catalog));
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const a = (await create(app)).json().profile;
    const b = (await create(app, tokenB, '私人')).json().profile;
    const send = (ref: string, action: string, extra = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/accounts/${ref}/claude/binding/${action}`,
        headers,
        payload: { projectPath: root, scope: 'local', ...extra },
      });
    const ap = await send(a.id, 'preview');
    assert.equal(ap.statusCode, 200, ap.body);
    assert.deepEqual(
      ap.json().targets.map((x: { catId: string }) => x.catId),
      ['opus', 'sonnet'],
    );
    assert.equal((await send(a.id, 'commit', { previewToken: ap.json().previewToken })).statusCode, 200);
    const inFlight = resolveForClient(root, 'anthropic', a.id)!;
    const bp = await send(b.id, 'preview');
    assert.equal(bp.statusCode, 200, bp.body);
    assert.equal((await send(b.id, 'commit', { previewToken: bp.json().previewToken })).statusCode, 200);
    assert.equal(inFlight.envVars?.CLAUDE_CODE_OAUTH_TOKEN, tokenA);
    const members = toAllCatConfigs(readRuntimeAccountMembers(root));
    assert.equal(members.opus.accountRef, b.id);
    assert.equal(members.sonnet.accountRef, b.id);
    assert.equal(members.sleepy.accountRef, 'claude');
    assert.equal(members.sol.accountRef, 'codex');
    assert.equal(
      resolveForClient(root, 'anthropic', members.opus.accountRef)?.envVars?.CLAUDE_CODE_OAUTH_TOKEN,
      tokenB,
    );
    const stale = await send(a.id, 'preview');
    await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${a.id}`,
      headers,
      payload: { projectPath: root, claudeToken: tokenB },
    });
    assert.equal((await send(a.id, 'commit', { previewToken: stale.json().previewToken })).statusCode, 409);
    updateRuntimeCat(root, 'sleepy', { available: true });
    assert.equal(toAllCatConfigs(readRuntimeAccountMembers(root)).sleepy.accountRef, b.id);
    const missing = await app.inject({ method: 'GET', url: '/api/accounts/claude/members' });
    assert.equal(missing.statusCode, 401);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${b.id}`,
      headers,
      payload: { projectPath: root },
    });
    assert.equal(removed.statusCode, 409);
  } finally {
    await app.close();
  }
});

test('missing or expired token stays visible, fails resolution, and recovers on the same account', async () => {
  const { writeCredential, deleteCredential } = await import('../src/config/credentials.js');
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const a = (await create(app)).json().profile;
    deleteCredential(a.id, root);
    assert.throws(() => resolveForClient(root, 'anthropic', a.id), /missing_or_expired/);
    const list = () => app.inject({ url: `/api/accounts?projectPath=${encodeURIComponent(root)}`, headers });
    assert.equal(
      (await list()).json().providers.find((p: { id: string }) => p.id === a.id).claudeTokenStatus,
      'missing',
    );
    writeCredential(a.id, { accessToken: tokenA, expiresAt: 1 }, root);
    assert.equal(
      (await list()).json().providers.find((p: { id: string }) => p.id === a.id).claudeTokenStatus,
      'expired',
    );
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${a.id}`,
      headers,
      payload: { projectPath: root, claudeToken: tokenB },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().profile.id, a.id);
    assert.equal(response.json().profile.claudeTokenStatus, 'saved');
    assert.equal(response.json().profile.displayName, '公司');
    for (const field of ['apiKey', 'baseUrl', 'envVars']) {
      const rejected = await app.inject({
        method: 'PATCH',
        url: `/api/accounts/${a.id}`,
        headers,
        payload: { projectPath: root, [field]: field === 'envVars' ? { HOME: '/foreign' } : 'fixture' },
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(readCredential(a.id, root)?.accessToken, tokenB);
    }
  } finally {
    await app.close();
  }
});
