import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { toAllCatConfigs } from '../src/config/cat-config-loader.js';
import { readRuntimeCatCatalog } from '../src/config/runtime-cat-catalog.js';
import { accountsRoutes } from '../src/routes/accounts.js';

const headers = { 'x-cat-cafe-user': 'fixture' };
let root: string, workspace: string, runtime: string;
let saved: NodeJS.ProcessEnv;
let registry: ReturnType<typeof catRegistry.getAllConfigs>;

function catalog(ids: string[], bound = 'codex') {
  return {
    version: 2,
    breeds: [
      {
        id: 'maine',
        catId: ids[0],
        name: '缅因猫',
        displayName: '缅因猫',
        avatar: '/avatars/codex.png',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: [`@${ids[0]}`],
        roleDescription: 'fixture',
        defaultVariantId: `${ids[0]}-default`,
        variants: ids.map((id) => ({
          id: `${id}-default`,
          catId: id,
          nickname: id.startsWith('old') ? '砚砚' : id,
          clientId: 'openai',
          defaultModel: 'gpt-6.1-sol',
          mcpSupport: true,
          accountRef: bound,
          mentionPatterns: [`@${id}`],
          cli: { command: 'codex', outputFormat: 'json' },
        })),
      },
    ],
    roster: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          family: 'maine',
          roles: ['assistant'],
          lead: false,
          available: true,
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
    coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
  };
}
function seedCatalog(path: string, ids: string[], bound?: string) {
  mkdirSync(join(path, '.cat-cafe'), { recursive: true });
  const bytes = JSON.stringify(catalog(ids, bound));
  writeFileSync(join(path, '.cat-cafe/cat-catalog.json'), bytes);
  writeFileSync(join(path, 'cat-template.json'), bytes);
}
beforeEach(() => {
  saved = { ...process.env };
  registry = catRegistry.getAllConfigs();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-member-owner-')));
  workspace = join(root, 'workspace');
  runtime = join(root, 'runtime');
  seedCatalog(workspace, ['old-codex', 'old-gpt52', 'old-spark', 'old-sol']);
  seedCatalog(runtime, ['sol61', 'astra']);
  mkdirSync(join(root, 'default-home'));
  Object.assign(process.env, {
    HOME: root,
    CODEX_HOME: join(root, 'default-home'),
    CAT_CAFE_CONFIG_ROOT: runtime,
    CAT_CAFE_RUNTIME_ROOT: runtime,
    CAT_CAFE_WORKSPACE_ROOT: workspace,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: workspace,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
    CAT_CAFE_PROJECT_ALLOWED_ROOTS: root,
    AUDIT_LOG_DIR: join(root, 'audit'),
    CAT_TEMPLATE_PATH: join(runtime, 'cat-template.json'),
  });
  delete process.env.CODEX_SQLITE_HOME;
  writeFileSync(
    join(workspace, '.cat-cafe/accounts.json'),
    JSON.stringify({
      codex: { authType: 'oauth', clientId: 'openai', envVars: { CODEX_HOME: join(root, 'default-home') } },
    }),
  );
  catRegistry.reset();
  for (const [id, config] of Object.entries(toAllCatConfigs(readRuntimeCatCatalog(runtime))))
    catRegistry.register(id, config);
});
afterEach(() => {
  catRegistry.reset();
  for (const [id, config] of Object.entries(registry)) catRegistry.register(id, config);
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

async function appWithAccount() {
  const app = Fastify();
  await app.register(accountsRoutes, {
    loginDriver: {
      async run(input) {
        input.onReady();
        const identity = { userId: 'fixture-user', workspaceId: 'fixture-workspace', email: 'fixture@example.test' };
        const jwt = `x.${Buffer.from(
          JSON.stringify({
            email: identity.email,
            'https://api.openai.com/auth': {
              chatgpt_user_id: identity.userId,
              chatgpt_account_id: identity.workspaceId,
            },
          }),
        ).toString('base64url')}.x`;
        mkdirSync(input.home, { recursive: true });
        writeFileSync(
          join(input.home, 'auth.json'),
          JSON.stringify({ tokens: { id_token: jwt, account_id: identity.workspaceId } }),
        );
        return identity;
      },
    },
  });
  const create = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers,
    payload: { projectPath: runtime, authType: 'oauth', clientId: 'openai', displayName: '备选主号' },
  });
  assert.equal(create.statusCode, 200, create.body);
  const ref: string = create.json().profile.id;
  const login = await app.inject({
    method: 'POST',
    url: `/api/accounts/${ref}/codex/login/start`,
    headers,
    payload: { projectPath: runtime },
  });
  assert.equal(login.statusCode, 200, login.body);
  await new Promise((resolve) => setImmediate(resolve));
  return { app, ref };
}

test('members use the running catalog even when account project is the persistent workspace', async () => {
  const { app } = await appWithAccount();
  try {
    for (const path of [runtime, workspace]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/accounts/codex/members?projectPath=${encodeURIComponent(path)}`,
        headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(
        response.json().members.map((member: { id: string }) => member.id),
        ['sol61', 'astra'],
      );
      assert.ok(
        response.json().members.every((member: { accountRef: string }) => member.accountRef === 'codex'),
        'logging in a backup must not switch the current account',
      );
    }
  } finally {
    await app.close();
  }
});

test('preview and commit use runtime members, update their registry, and preserve the account owner and old catalog', async () => {
  const { app, ref } = await appWithAccount();
  const workspaceBefore = readFileSync(join(workspace, '.cat-cafe/cat-catalog.json'), 'utf8');
  const accountsBefore = readFileSync(join(workspace, '.cat-cafe/accounts.json'), 'utf8');
  const accepted = catRegistry.getOrThrow('sol61').config;
  try {
    const preview = await app.inject({
      method: 'POST',
      url: `/api/accounts/${ref}/codex/binding/preview`,
      headers,
      payload: { projectPath: runtime, catId: 'sol61', scope: 'family' },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(
      preview.json().targets.map((target: { catId: string }) => target.catId),
      ['astra', 'sol61'],
    );
    const commit = await app.inject({
      method: 'POST',
      url: `/api/accounts/${ref}/codex/binding/commit`,
      headers,
      payload: { projectPath: runtime, catId: 'sol61', scope: 'family', previewToken: preview.json().previewToken },
    });
    assert.equal(commit.statusCode, 200, commit.body);
    for (const id of ['sol61', 'astra']) {
      assert.equal(toAllCatConfigs(readRuntimeCatCatalog(runtime))[id].accountRef, ref);
      assert.equal(catRegistry.getOrThrow(id).config.accountRef, ref);
    }
    assert.equal(accepted.accountRef, 'codex', 'in-flight accepted config keeps its account');
    assert.equal(readFileSync(join(workspace, '.cat-cafe/cat-catalog.json'), 'utf8'), workspaceBefore);
    assert.equal(readFileSync(join(workspace, '.cat-cafe/accounts.json'), 'utf8'), accountsBefore);
  } finally {
    await app.close();
  }
});

test('delete refuses an account referenced by a runtime member absent from the workspace catalog', async () => {
  const { app, ref } = await appWithAccount();
  seedCatalog(runtime, ['sol61', 'astra'], ref);
  const accountsBefore = readFileSync(join(workspace, '.cat-cafe/accounts.json'), 'utf8');
  try {
    const result = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${ref}`,
      headers,
      payload: { projectPath: runtime },
    });
    assert.equal(result.statusCode, 409, result.body);
    assert.deepEqual(result.json().boundCatIds, ['sol61', 'astra']);
    assert.equal(readFileSync(join(workspace, '.cat-cafe/accounts.json'), 'utf8'), accountsBefore);
  } finally {
    await app.close();
  }
});

test('a staging config override remains the member owner instead of the formal runtime root', async () => {
  const staging = join(root, 'staging');
  seedCatalog(staging, ['preview-sol']);
  process.env.CAT_CAFE_CONFIG_ROOT = staging;
  process.env.CAT_TEMPLATE_PATH = join(staging, 'cat-template.json');
  const { app } = await appWithAccount();
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/accounts/codex/members?projectPath=${encodeURIComponent(runtime)}`,
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().members.map((member: { id: string }) => member.id),
      ['preview-sol'],
    );
  } finally {
    await app.close();
  }
});

test('a changed runtime catalog invalidates the preview without writing either owner', async () => {
  const { app, ref } = await appWithAccount();
  try {
    const payload = { projectPath: runtime, catId: 'sol61', scope: 'family' };
    const preview = await app.inject({
      method: 'POST',
      url: `/api/accounts/${ref}/codex/binding/preview`,
      headers,
      payload,
    });
    assert.equal(preview.statusCode, 200, preview.body);
    seedCatalog(runtime, ['sol61', 'astra', 'new-local']);
    readRuntimeCatCatalog(runtime);
    const before = readFileSync(join(runtime, '.cat-cafe/cat-catalog.json'), 'utf8');
    const commit = await app.inject({
      method: 'POST',
      url: `/api/accounts/${ref}/codex/binding/commit`,
      headers,
      payload: { ...payload, previewToken: preview.json().previewToken },
    });
    assert.equal(commit.statusCode, 409, commit.body);
    assert.match(commit.json().error, /preview changed/);
    assert.equal(readFileSync(join(runtime, '.cat-cafe/cat-catalog.json'), 'utf8'), before);
    assert.equal(catRegistry.getOrThrow('sol61').config.accountRef, 'codex');
  } finally {
    await app.close();
  }
});

test('unreadable runtime binding truth blocks non-force deletion rather than consulting the clean old workspace', async () => {
  const { app, ref } = await appWithAccount();
  const before = readFileSync(join(workspace, '.cat-cafe/accounts.json'), 'utf8');
  writeFileSync(join(runtime, '.cat-cafe/cat-catalog.json'), '{broken');
  try {
    const result = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${ref}`,
      headers,
      payload: { projectPath: runtime },
    });
    assert.equal(result.statusCode, 500, result.body);
    assert.match(result.json().error, /Cannot verify account references/);
    assert.equal(readFileSync(join(workspace, '.cat-cafe/accounts.json'), 'utf8'), before);
  } finally {
    await app.close();
  }
});
