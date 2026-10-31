import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { toAllCatConfigs } from '../src/config/cat-config-loader.js';
import { readRuntimeAccountMembers, updateRuntimeCat } from '../src/config/runtime-cat-catalog.js';
import { accountsRoutes } from '../src/routes/accounts.js';

let root: string;
let saved: NodeJS.ProcessEnv;
let registry: ReturnType<typeof catRegistry.getAllConfigs>;
const headers = { 'x-cat-cafe-user': 'fixture' };
function seed(mixed = false) {
  const variant = (id: string, ref = 'codex') => ({
    id,
    catId: id,
    clientId: 'openai',
    defaultModel: 'gpt-6.1-sol',
    mcpSupport: true,
    accountRef: ref,
    cli: { command: 'codex', outputFormat: 'json' },
  });
  const breed = (id: string, variants: ReturnType<typeof variant>[]) => ({
    id,
    catId: variants[0].catId,
    name: id,
    displayName: id,
    avatar: '/avatars/codex.png',
    color: { primary: '#123456', secondary: '#abcdef' },
    mentionPatterns: [`@${id}`],
    roleDescription: 'fixture',
    defaultVariantId: variants[0].id,
    variants,
  });
  const catalog = {
    version: 2,
    breeds: [
      breed('one', [variant('sol'), variant('disabled')]),
      breed('two', [variant('astra', mixed ? 'backup' : 'codex'), variant('gpt-pro')]),
    ],
    roster: Object.fromEntries(
      ['sol', 'disabled', 'astra', 'gpt-pro'].map((id) => [
        id,
        {
          family: id === 'astra' ? 'other' : 'maine',
          roles: ['assistant'],
          lead: false,
          available: id !== 'disabled',
          evaluation: 'fixture',
        },
      ]),
    ),
    reviewPolicy: {
      requireDifferentFamily: false,
      preferActiveInThread: false,
      preferLead: false,
      excludeUnavailable: true,
    },
  };
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(catalog));
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({
      backup: {
        authType: 'api_key',
        clientId: 'openai',
        displayName: '备选号',
        baseUrl: 'https://example.test/v1',
        models: ['gpt-6.1-sol'],
      },
    }),
  );
  writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ backup: { apiKey: 'fixture-only' } }));
}
beforeEach(() => {
  saved = { ...process.env };
  registry = catRegistry.getAllConfigs();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-selection-')));
  mkdirSync(join(root, '.cat-cafe'));
  Object.assign(process.env, {
    HOME: root,
    CODEX_HOME: join(root, '.codex'),
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_RUNTIME_ROOT: root,
    CAT_CAFE_WORKSPACE_ROOT: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
    CAT_CAFE_PROJECT_ALLOWED_ROOTS: root,
    CAT_TEMPLATE_PATH: join(root, 'cat-template.json'),
    AUDIT_LOG_DIR: join(root, 'audit'),
  });
  delete process.env.CODEX_SQLITE_HOME;
  seed();
});
afterEach(() => {
  catRegistry.reset();
  for (const [id, config] of Object.entries(registry)) catRegistry.register(id, config);
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
async function app() {
  const server = Fastify();
  await server.register(accountsRoutes);
  return server;
}

test('native default appears without creating an account and separates absent from unreadable auth', async () => {
  const server = await app();
  const before = readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8');
  try {
    const list = () =>
      server.inject({ method: 'GET', url: `/api/accounts?projectPath=${encodeURIComponent(root)}`, headers });
    const native = (await list()).json().providers.find((p: { id: string }) => p.id === 'codex');
    assert.ok(native, 'runtime synthesized default must be visible without adding it');
    assert.equal(native.displayName, 'Codex App 登录（本机默认）');
    assert.equal(native.codexLoginStatus, 'not_logged_in');
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex/auth.json'), '{broken');
    assert.equal(
      (await list()).json().providers.find((p: { id: string }) => p.id === 'codex').codexLoginStatus,
      'unreadable',
    );
    assert.equal(readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8'), before);
  } finally {
    await server.close();
  }
});

test('local scope crosses families, excludes disabled/cloud, and persists one selection atomically', async () => {
  const server = await app();
  try {
    const send = (action: string, extra = {}) =>
      server.inject({
        method: 'POST',
        url: `/api/accounts/backup/codex/binding/${action}`,
        headers,
        payload: { projectPath: root, scope: 'local', ...extra },
      });
    const preview = await send('preview');
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(
      preview.json().targets.map((p: { catId: string }) => p.catId),
      ['astra', 'sol'],
    );
    const commit = await send('commit', { previewToken: preview.json().previewToken });
    assert.equal(commit.statusCode, 200, commit.body);
    const catalog = JSON.parse(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'));
    assert.equal(catalog.selectedAccountRefs.openai, 'backup');
    const variants = catalog.breeds.flatMap(
      (b: { variants: Array<{ catId: string; accountRef: string; accountBindingMode: string }> }) => b.variants,
    );
    assert.equal(variants.find((v: { catId: string }) => v.catId === 'astra').accountBindingMode, 'follow');
    assert.equal(variants.find((v: { catId: string }) => v.catId === 'disabled').accountRef, 'codex');
    assert.equal(variants.find((v: { catId: string }) => v.catId === 'gpt-pro').accountRef, 'codex');
  } finally {
    await server.close();
  }
});

test('mixed legacy accounts are not normalized and exceptions require explicit inclusion', async () => {
  seed(true);
  const server = await app();
  const before = readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8');
  try {
    const members = await server.inject({ method: 'GET', url: '/api/accounts/codex/members', headers });
    assert.equal(members.json().selection.state, 'mixed');
    assert.equal(members.json().selection.accountRef, undefined);
    assert.equal(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'), before);
    const preview = await server.inject({
      method: 'POST',
      url: '/api/accounts/backup/codex/binding/preview',
      headers,
      payload: { scope: 'local' },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(
      preview.json().exceptions.map((p: { catId: string }) => p.catId),
      ['sol'],
    );
    const changed = await server.inject({
      method: 'POST',
      url: '/api/accounts/backup/codex/binding/commit',
      headers,
      payload: { scope: 'local', includeOverrides: true, previewToken: preview.json().previewToken },
    });
    assert.equal(changed.statusCode, 409, 'changing included owners requires a fresh preview');
  } finally {
    await server.close();
  }
});

test('default login shows its actual configured home and identity without persisting tokens', async () => {
  const home = join(root, 'custom-home');
  mkdirSync(home);
  const claims = {
    email: 'native@example.test',
    'https://api.openai.com/auth': { chatgpt_user_id: 'native-user', chatgpt_account_id: 'native-workspace' },
  };
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      tokens: {
        id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`,
        account_id: 'native-workspace',
      },
    }),
  );
  process.env.CODEX_HOME = home;
  const server = await app();
  try {
    const response = await server.inject({ method: 'GET', url: '/api/accounts', headers });
    const native = response.json().providers.find((p: { id: string }) => p.id === 'codex');
    assert.equal(native.displayName, '本机默认登录');
    assert.equal(native.nativeLogin.home, home);
    assert.equal(native.nativeLogin.identity.email, 'native@example.test');
    assert.equal(native.codexLoginStatus, 'ready');
    assert.equal(response.body.includes('id_token'), false);
  } finally {
    await server.close();
  }
});

test('confirmed mixed selection preserves exceptions and member restore-follow stays local', async () => {
  seed(true);
  const server = await app();
  try {
    const preview = await server.inject({
      method: 'POST',
      url: '/api/accounts/backup/codex/binding/preview',
      headers,
      payload: { scope: 'local' },
    });
    const commit = await server.inject({
      method: 'POST',
      url: '/api/accounts/backup/codex/binding/commit',
      headers,
      payload: { scope: 'local', previewToken: preview.json().previewToken },
    });
    assert.equal(commit.statusCode, 200, commit.body);
    let cats = toAllCatConfigs(readRuntimeAccountMembers(root));
    assert.equal(cats.sol.accountRef, 'codex');
    assert.equal(cats.sol.accountBindingMode, 'override');
    updateRuntimeCat(root, 'sol', { accountRef: 'backup', accountBindingMode: 'follow' });
    cats = toAllCatConfigs(readRuntimeAccountMembers(root));
    assert.equal(cats.sol.accountRef, 'backup');
    assert.equal(cats.sol.accountBindingMode, 'follow');
    const before = readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8');
    assert.throws(
      () => updateRuntimeCat(root, 'gpt-pro', { accountBindingMode: 'follow', accountRef: 'backup' }),
      /本地 Codex/,
    );
    assert.equal(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8'), before);
  } finally {
    await server.close();
  }
});

test('invalid member schema does not hide healthy registered accounts', async () => {
  const path = join(root, '.cat-cafe/cat-catalog.json');
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  catalog.breeds[0].variants[0].defaultModel = 42;
  writeFileSync(path, JSON.stringify(catalog));
  const server = await app();
  try {
    const list = await server.inject({ method: 'GET', url: '/api/accounts', headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().providers[0].id, 'backup');
    assert.match(list.json().nativeDefaultsError, /读不到/);
  } finally {
    await server.close();
  }
});

test('a default configured for another credential store cannot be authenticated by a leftover file', async () => {
  const home = join(root, '.codex');
  mkdirSync(home);
  writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store="keyring"\n');
  const claims = {
    'https://api.openai.com/auth': { chatgpt_user_id: 'leftover-user', chatgpt_account_id: 'leftover-workspace' },
  };
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      tokens: {
        id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`,
        account_id: 'leftover-workspace',
      },
    }),
  );
  const server = await app();
  try {
    const list = await server.inject({ method: 'GET', url: '/api/accounts', headers });
    const native = list.json().providers.find((p: { id: string }) => p.id === 'codex');
    assert.equal(native.codexLoginStatus, 'unreadable');
    assert.equal(native.nativeLogin.identity, undefined);
  } finally {
    await server.close();
  }
});
