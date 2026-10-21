import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { accountsRoutes } from '../src/routes/accounts.js';
import { catsRoutes } from '../src/routes/cats.js';

let root: string;
let saved: NodeJS.ProcessEnv;
let registry: ReturnType<typeof catRegistry.getAllConfigs>;
let server: FastifyInstance;
const headers = { 'x-cat-cafe-user': 'fixture' };
const catalogPath = () => join(root, '.cat-cafe/cat-catalog.json');
const raw = () => JSON.parse(readFileSync(catalogPath(), 'utf8'));
const member = (id: string) =>
  raw()
    .breeds.flatMap((b: { variants: { catId: string }[] }) => b.variants)
    .find((v: { catId: string }) => v.catId === id);
function seed() {
  const variant = (id: string, ref = 'codex', client = 'openai') => ({
    id,
    catId: id,
    clientId: client,
    accountRef: ref,
    defaultModel: client === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-4-5-20250929',
    mcpSupport: true,
    cli: { command: client === 'openai' ? 'codex' : 'claude', outputFormat: 'json' },
  });
  const catalog = {
    version: 2,
    selectedAccountRefs: { openai: 'codex' },
    breeds: [
      {
        id: 'maine',
        catId: 'sol',
        name: 'Maine',
        displayName: 'Maine',
        avatar: '/avatars/codex.png',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@sol'],
        roleDescription: 'fixture',
        defaultVariantId: 'sol',
        variants: [
          variant('sol'),
          variant('disabled'),
          { ...variant('override', 'other'), accountBindingMode: 'override' },
          { ...variant('disabled-override', 'other'), accountBindingMode: 'override' },
          {
            ...variant('opus', 'claude', 'acp'),
            acp: { command: 'custom-acp', startupArgs: ['--acp'] },
            customExtension: { keep: [1, 'x'] },
          },
        ],
        breedExtension: { keep: true },
      },
    ],
    roster: Object.fromEntries(
      ['sol', 'disabled', 'override', 'disabled-override', 'opus'].map((id) => [
        id,
        {
          family: 'maine',
          roles: ['assistant'],
          lead: false,
          available: !id.startsWith('disabled'),
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
    rootExtension: { keep: 'raw' },
  };
  writeFileSync(catalogPath(), JSON.stringify(catalog));
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(catalog));
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify(
      Object.fromEntries(
        ['next', 'other'].map((id) => [
          id,
          {
            authType: 'api_key',
            clientId: 'openai',
            displayName: id,
            baseUrl: 'https://fixture.test/v1',
            models: ['gpt-6.1-sol'],
          },
        ]),
      ),
    ),
  );
  writeFileSync(
    join(root, '.cat-cafe/credentials.json'),
    JSON.stringify({ next: { apiKey: 'fake' }, other: { apiKey: 'fake' } }),
  );
}
beforeEach(async () => {
  saved = { ...process.env };
  registry = catRegistry.getAllConfigs();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-binding-red-')));
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
  seed();
  server = Fastify();
  await server.register(accountsRoutes);
  await server.register(catsRoutes);
});
afterEach(async () => {
  await server.close();
  catRegistry.reset();
  for (const [id, config] of Object.entries(registry)) catRegistry.register(id, config);
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
const preview = (includeOverrides = false, ref = 'next', scope = 'local') =>
  server.inject({
    method: 'POST',
    url: `/api/accounts/${ref}/codex/binding/preview`,
    headers,
    payload: { scope, ...(scope === 'local' ? {} : { catId: 'sol' }), includeOverrides },
  });
const commit = (previewToken: string, includeOverrides = false, ref = 'next') =>
  server.inject({
    method: 'POST',
    url: `/api/accounts/${ref}/codex/binding/commit`,
    headers,
    payload: { scope: 'local', includeOverrides, previewToken },
  });
const patch = (id: string, payload: object) =>
  server.inject({ method: 'PATCH', url: `/api/cats/${id}`, headers, payload });

test('local binding preserves all non-target ACP and raw extension fields', async () => {
  const before = raw();
  const plan = await preview();
  const result = await commit(plan.json().previewToken);
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(
    member('opus'),
    before.breeds[0].variants.find((v: { catId: string }) => v.catId === 'opus'),
  );
  assert.deepEqual(raw().rootExtension, before.rootExtension);
  assert.deepEqual(raw().breeds[0].breedExtension, before.breeds[0].breedExtension);
});

test('included overrides move into targets, leave no exceptions, and require fresh confirmation', async () => {
  const excluded = await preview();
  assert.deepEqual(
    excluded.json().exceptions.map((m: { catId: string }) => m.catId),
    ['override'],
  );
  const stale = await commit(excluded.json().previewToken, true);
  assert.equal(stale.statusCode, 409);
  const included = await preview(true);
  assert.deepEqual(
    included.json().targets.map((m: { catId: string }) => m.catId),
    ['override', 'sol'],
  );
  assert.deepEqual(included.json().exceptions, []);
  const result = await commit(included.json().previewToken, true);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(member('override').accountRef, 'next');
  assert.equal(member('override').accountBindingMode, 'follow');
});

test('disabled legacy follower resumes selection while explicit disabled override retains its account', async () => {
  const plan = await preview();
  assert.equal((await commit(plan.json().previewToken)).statusCode, 200);
  assert.equal(member('disabled').accountRef, 'codex', 'disabled member does not execute a binding switch');
  assert.equal(member('disabled').accountBindingMode, 'follow');
  const second = await preview(false, 'other');
  assert.equal((await commit(second.json().previewToken, false, 'other')).statusCode, 200);
  assert.equal(member('disabled').accountBindingMode, 'follow', 'inactive intent survives more than one selection');
  const back = await preview();
  assert.equal((await commit(back.json().previewToken)).statusCode, 200);
  const enabled = await patch('disabled', { available: true });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(member('disabled').accountRef, 'next');
  assert.equal(member('disabled').accountBindingMode, 'follow');
  const exception = await patch('disabled-override', { available: true });
  assert.equal(exception.statusCode, 200, exception.body);
  assert.equal(member('disabled-override').accountRef, 'other');
  assert.equal(member('disabled-override').accountBindingMode, 'override');
});

test('member editor validates the complete next client/CLI/binding state', async () => {
  const response = await patch('opus', {
    clientId: 'openai',
    defaultModel: 'gpt-6.1-sol',
    accountRef: 'next',
    accountBindingMode: 'override',
    cli: { command: 'codex', outputFormat: 'json' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(member('opus').clientId, 'openai');
  assert.equal(member('opus').accountRef, 'next');
  assert.equal(member('opus').accountBindingMode, 'override');
  const cloud = await patch('opus', { cli: null, accountBindingMode: 'follow' });
  assert.equal(cloud.statusCode, 400, cloud.body);
  assert.ok(member('opus').cli, 'failed next-state validation must not write');
});

test('native readiness guards explicit member selection and follow without blocking read-only legacy startup', async () => {
  const read = await server.inject({ method: 'GET', url: '/api/cats', headers });
  assert.equal(read.statusCode, 200, read.body);
  const before = readFileSync(catalogPath(), 'utf8');
  for (const payload of [{ accountBindingMode: 'follow' }, { accountRef: 'codex', accountBindingMode: 'follow' }]) {
    const response = await patch('sol', payload);
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /未登录|读不到/);
  }
  const change = await patch('override', { accountRef: 'codex' });
  assert.equal(change.statusCode, 400, change.body);
  assert.match(change.json().error, /未登录|读不到/);
  for (const scope of ['cat', 'family', 'local']) {
    assert.equal((await preview(false, 'codex', scope)).statusCode, 409);
  }
  assert.equal(readFileSync(catalogPath(), 'utf8'), before);
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex/auth.json'), '{broken');
  assert.equal((await patch('sol', { accountRef: 'codex', accountBindingMode: 'follow' })).statusCode, 400);
  const claims = {
    'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-workspace' },
  };
  writeFileSync(
    join(root, '.codex/auth.json'),
    JSON.stringify({
      tokens: {
        id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`,
        account_id: 'fixture-workspace',
      },
    }),
  );
  const ready = await patch('sol', { accountRef: 'codex', accountBindingMode: 'follow' });
  assert.equal(ready.statusCode, 200, ready.body);
});
