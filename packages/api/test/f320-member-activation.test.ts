import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { catsRoutes } from '../src/routes/cats.js';

let root: string;
let saved: NodeJS.ProcessEnv;
let registry: ReturnType<typeof catRegistry.getAllConfigs>;
let server: FastifyInstance;
const headers = { 'x-cat-cafe-user': 'fixture' };
const managedRef = 'codex-00000000-0000-0000-0000-000000000001';
const identity = { userId: 'fixture-user', workspaceId: 'fixture-workspace' };
const catalogPath = () => join(root, '.cat-cafe/cat-catalog.json');
const raw = () => JSON.parse(readFileSync(catalogPath(), 'utf8'));
function configure(mode: 'follow' | 'override' = 'follow', ref = 'codex', cli = true) {
  const catalog = {
    version: 2,
    selectedAccountRefs: { openai: ref },
    breeds: [
      {
        id: 'maine',
        catId: 'disabled',
        name: 'Maine',
        displayName: 'Maine',
        avatar: '/avatars/codex.png',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@disabled'],
        roleDescription: 'fixture',
        defaultVariantId: 'disabled',
        variants: [
          {
            id: 'disabled',
            catId: 'disabled',
            clientId: 'openai',
            defaultModel: 'gpt-6.1-sol',
            mcpSupport: true,
            accountRef: ref,
            accountBindingMode: mode,
            ...(cli ? { cli: { command: 'codex', outputFormat: 'json' } } : {}),
          },
        ],
      },
    ],
    coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
    roster: {
      disabled: { family: 'maine', roles: ['assistant'], lead: false, available: false, evaluation: 'fixture' },
      owner: { family: 'owner', roles: ['owner'], lead: false, available: true, evaluation: 'fixture' },
    },
    reviewPolicy: {
      requireDifferentFamily: false,
      preferActiveInThread: false,
      preferLead: false,
      excludeUnavailable: true,
    },
  };
  writeFileSync(catalogPath(), JSON.stringify(catalog, null, 2) + '\n');
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(catalog));
}
function auth(home: string, state: 'unreadable' | 'ready') {
  mkdirSync(home, { recursive: true });
  const claims = {
    'https://api.openai.com/auth': { chatgpt_user_id: identity.userId, chatgpt_account_id: identity.workspaceId },
  };
  writeFileSync(
    join(home, 'auth.json'),
    state === 'unreadable'
      ? '{broken'
      : JSON.stringify({
          tokens: {
            id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`,
            account_id: identity.workspaceId,
          },
        }),
  );
}
beforeEach(async () => {
  saved = { ...process.env };
  registry = catRegistry.getAllConfigs();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-active-binding-')));
  mkdirSync(join(root, '.cat-cafe'));
  Object.assign(process.env, {
    HOME: root,
    CODEX_HOME: join(root, '.codex'),
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_RUNTIME_ROOT: root,
    CAT_CAFE_WORKSPACE_ROOT: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_TEMPLATE_PATH: join(root, 'cat-template.json'),
    CAT_CAFE_PROJECT_ALLOWED_ROOTS: root,
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
    AUDIT_LOG_DIR: join(root, 'audit'),
  });
  delete process.env.CODEX_SQLITE_HOME;
  configure();
  server = Fastify();
  await server.register(catsRoutes);
});
afterEach(async () => {
  await server.close();
  catRegistry.reset();
  for (const [id, config] of Object.entries(registry)) catRegistry.register(id, config);
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
const patch = (payload: object) => server.inject({ method: 'PATCH', url: '/api/cats/disabled', headers, payload });
const create = (extra = {}) =>
  server.inject({
    method: 'POST',
    url: '/api/cats',
    headers,
    payload: {
      catId: 'created',
      name: 'Created',
      displayName: 'Created',
      color: { primary: '#123456', secondary: '#abcdef' },
      mentionPatterns: ['@created'],
      roleDescription: 'fixture',
      clientId: 'openai',
      defaultModel: 'gpt-6.1-sol',
      accountRef: 'codex',
      ...extra,
    },
  });
async function refusesWithoutWrite(request: () => ReturnType<typeof patch>, expected = /未登录|读不到/) {
  const before = readFileSync(catalogPath(), 'utf8');
  const result = await request();
  assert.equal(result.statusCode, 400, result.body);
  assert.match(result.json().error, expected);
  assert.equal(readFileSync(catalogPath(), 'utf8'), before);
}
for (const mode of ['follow', 'override'] as const) {
  test(`${mode} activation checks native readiness even when selected and member refs are unchanged`, async () => {
    configure(mode);
    await refusesWithoutWrite(() => patch({ available: true }));
    auth(join(root, '.codex'), 'unreadable');
    await refusesWithoutWrite(() => patch({ available: true }));
    auth(join(root, '.codex'), 'ready');
    const ready = await patch({ available: true });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(raw().roster.disabled.available, true);
    assert.equal(raw().breeds[0].variants[0].accountRef, 'codex');
  });
  test(`${mode} managed activation checks its own credentials and never adopts default identity`, async () => {
    const layout = prepareCodexManagedLayout(describeCodexManagedLayout(root, managedRef));
    writeCatalogAccount(root, managedRef, { authType: 'oauth', clientId: 'openai', codex: { ...layout, identity } });
    configure(mode, managedRef);
    auth(join(root, '.codex'), 'ready');
    await refusesWithoutWrite(() => patch({ available: true }), /尚未完成登录|身份已改变/);
    auth(layout.credentialHome, 'unreadable');
    await refusesWithoutWrite(() => patch({ available: true }), /尚未完成登录|身份已改变/);
    auth(layout.credentialHome, 'ready');
    const ready = await patch({ available: true });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(raw().roster.disabled.available, true);
    assert.equal(raw().breeds[0].variants[0].accountRef, managedRef);
  });
}
test('new active native Codex member rejects absent/unreadable login and accepts ready', async () => {
  await refusesWithoutWrite(() => create());
  auth(join(root, '.codex'), 'unreadable');
  await refusesWithoutWrite(() => create());
  auth(join(root, '.codex'), 'ready');
  const ready = await create();
  assert.equal(ready.statusCode, 201, ready.body);
  assert.equal(raw().roster.created.available, true);
});
test('adding CLI to an enabled non-dispatching member is another local binding activation', async () => {
  configure('override', 'codex', false);
  const catalog = raw();
  catalog.roster.disabled.available = true;
  delete catalog.breeds[0].variants[0].accountBindingMode;
  writeFileSync(catalogPath(), JSON.stringify(catalog, null, 2) + '\n');
  await refusesWithoutWrite(() => patch({ cli: { command: 'codex', outputFormat: 'json' } }));
  auth(join(root, '.codex'), 'ready');
  const ready = await patch({ cli: { command: 'codex', outputFormat: 'json' } });
  assert.equal(ready.statusCode, 200, ready.body);
});
test('legacy reads, non-binding edits and removing local dispatch do not require a native login', async () => {
  const get = await server.inject({ method: 'GET', url: '/api/cats', headers });
  assert.equal(get.statusCode, 200, get.body);
  const name = await patch({ nickname: 'Offline note' });
  assert.equal(name.statusCode, 200, name.body);
  const activeLegacy = raw();
  activeLegacy.roster.disabled.available = true;
  writeFileSync(catalogPath(), `${JSON.stringify(activeLegacy, null, 2)}\n`);
  const activeName = await patch({ nickname: 'Active legacy note' });
  assert.equal(activeName.statusCode, 200, activeName.body);
  const cloud = await patch({ available: true, cli: null });
  assert.equal(cloud.statusCode, 200, cloud.body);
  assert.equal(raw().breeds[0].variants[0].cli, undefined);
});
test('new cloud-only OpenAI member remains outside local credential admission', async () => {
  const result = await create({ provider: 'openai-chatgpt-pro' });
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(raw().breeds.find((b: { catId: string }) => b.catId === 'created').variants[0].cli, undefined);
});
