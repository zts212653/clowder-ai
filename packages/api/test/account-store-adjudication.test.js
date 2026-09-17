import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import {
  resolveAnthropicRuntimeProfile,
  resolveByAccountRef,
  resolveForClient,
} from '../dist/config/account-resolver.js';
import { readCatalogAccounts, resetMigrationState, writeCatalogAccount } from '../dist/config/catalog-accounts.js';

let root;
let workspace;
let runtime;
let saved;
const envKeys = [
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'CAT_CAFE_SKIP_HOMEDIR_MIGRATION',
  'CAT_CAFE_CONFIG_ROOT',
  'CAT_TEMPLATE_PATH',
];
const account = { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://fixture.invalid', models: ['fixture'] };
const credential = { apiKey: 'FAKE_LOCAL_TEST_KEY' };
const put = (dir, name, value) => writeFileSync(join(dir, '.cat-cafe', name), JSON.stringify(value));
const pair = (dir, acct = account, key = credential) => {
  put(dir, 'accounts.json', { fixture: acct });
  put(dir, 'credentials.json', { fixture: key });
};

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), 'account-adjudication-'));
  workspace = join(root, 'workspace');
  runtime = join(root, 'runtime');
  for (const dir of [workspace, runtime]) {
    mkdirSync(join(dir, '.cat-cafe'), { recursive: true });
    mkdirSync(join(dir, 'packages/api'), { recursive: true });
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  }
  process.env.CAT_CAFE_RUNTIME_ROOT = runtime;
  process.env.CAT_CAFE_WORKSPACE_ROOT = workspace;
  process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION = '1';
  process.env.CAT_CAFE_CONFIG_ROOT = runtime;
  process.env.CAT_TEMPLATE_PATH = join(runtime, 'cat-template.json');
  delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  resetMigrationState();
});

test('account creation, cat binding and save share the workspace pair from a runtime catalog', async () => {
  const catalog = {
    version: 2,
    breeds: [
      {
        id: 'fixture-breed',
        catId: 'account-fixture-cat',
        name: 'Fixture',
        displayName: 'Fixture',
        avatar: '/avatars/opus.png',
        color: { primary: '#111111', secondary: '#eeeeee' },
        mentionPatterns: ['@account-fixture-cat'],
        roleDescription: 'fixture',
        defaultVariantId: 'fixture-variant',
        variants: [
          {
            id: 'fixture-variant',
            clientId: 'anthropic',
            accountRef: 'claude',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
          },
        ],
      },
    ],
    roster: {},
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
  };
  writeFileSync(process.env.CAT_TEMPLATE_PATH, JSON.stringify(catalog));
  put(runtime, 'cat-catalog.json', catalog);
  put(workspace, 'accounts.json', { claude: { authType: 'oauth' } });
  const Fastify = (await import('fastify')).default;
  const { accountsRoutes } = await import('../dist/routes/accounts.js');
  const { catsRoutes } = await import('../dist/routes/cats.js');
  const app = Fastify();
  await app.register(accountsRoutes);
  await app.register(catsRoutes);
  const headers = { 'x-cat-cafe-user': 'fixture-owner' };
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers,
      payload: {
        displayName: 'Fixture Gateway',
        clientId: 'anthropic',
        authType: 'api_key',
        baseUrl: account.baseUrl,
        apiKey: credential.apiKey,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const ref = created.json().profile.id;
    const bound = await app.inject({
      method: 'PATCH',
      url: '/api/cats/account-fixture-cat',
      headers,
      payload: { accountRef: ref, clientId: 'anthropic' },
    });
    assert.equal(bound.statusCode, 200, bound.body);
    const savedAccount = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${ref}`,
      headers,
      payload: { displayName: 'Renamed Fixture' },
    });
    assert.equal(savedAccount.statusCode, 200, savedAccount.body);
    for (const dir of [workspace, runtime, join(runtime, 'packages/api')]) {
      assert.equal(resolveForClient(dir, 'anthropic', ref)?.apiKey, credential.apiKey);
      assert.equal(readCatalogAccounts(dir)[ref].displayName, 'Renamed Fixture');
    }
    assert.equal(existsSync(join(runtime, '.cat-cafe/accounts.json')), false);
    assert.equal(existsSync(join(runtime, '.cat-cafe/credentials.json')), false);
  } finally {
    await app.close();
  }
});

test('accounts list reports a legacy-only credential from the selected snapshot without materializing it', async () => {
  pair(runtime);
  const Fastify = (await import('fastify')).default;
  const { accountsRoutes } = await import('../dist/routes/accounts.js');
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { 'x-cat-cafe-user': 'fixture-owner' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().providers.find((entry) => entry.id === 'fixture').hasApiKey, true);
    assert.equal(existsSync(join(workspace, '.cat-cafe/accounts.json')), false);
  } finally {
    await app.close();
  }
});

for (const failure of ['divergent', 'torn', 'malformed', 'malformed-credential', 'orphan']) {
  test(`mixed catalog keeps good accounts and reports a ${failure} ref without secret disclosure`, async () => {
    put(workspace, 'accounts.json', {
      good: account,
      ...(failure === 'orphan' ? {} : { bad: failure === 'malformed' ? { authType: 'broken' } : account }),
    });
    put(workspace, 'credentials.json', {
      good: credential,
      bad: failure === 'malformed-credential' ? { apiKey: 42 } : credential,
    });
    if (failure === 'divergent') {
      put(runtime, 'accounts.json', { bad: { ...account, models: ['different'] } });
      put(runtime, 'credentials.json', { bad: credential });
    }
    if (failure === 'torn') put(runtime, 'accounts.json', { bad: account });
    const files = [join(workspace, '.cat-cafe/accounts.json'), join(workspace, '.cat-cafe/credentials.json')];
    const before = files.map((path) => readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(readCatalogAccounts(workspace)), ['good']);
    assert.equal(resolveForClient(workspace, 'anthropic', 'good').apiKey, credential.apiKey);
    assert.throws(() => resolveForClient(workspace, 'anthropic', 'bad'));
    assert.throws(() => writeCatalogAccount(workspace, 'bad', account));
    const Fastify = (await import('fastify')).default;
    const { accountsRoutes } = await import('../dist/routes/accounts.js');
    const app = Fastify();
    await app.register(accountsRoutes);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/accounts',
        headers: { 'x-cat-cafe-user': 'fixture' },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(
        response.json().providers.map((entry) => entry.id),
        ['good'],
      );
      assert.equal(response.json().unavailableAccounts[0].accountRef, 'bad');
      assert.equal(response.json().unavailableAccounts[0].state, 'rejected');
      assert.ok(response.json().unavailableAccounts[0].reason);
      assert.ok(!response.body.includes(credential.apiKey));
    } finally {
      await app.close();
    }
    assert.deepEqual(
      files.map((path) => readFileSync(path, 'utf8')),
      before,
    );
  });
}

for (const version of [1, 2, 3]) {
  for (const corrupt of ['account', 'credential']) {
    test(`legacy v${version} ${corrupt} errors stay local to an identifiable ref`, () => {
      put(workspace, 'accounts.json', { good: account });
      const profiles = [{ id: 'bad', authType: 'api_key', ...(corrupt === 'account' ? { models: 42 } : {}) }];
      put(
        runtime,
        'provider-profiles.json',
        version === 1
          ? { version, providers: { anthropic: { profiles } } }
          : { version, [version === 2 ? 'providers' : 'profiles']: profiles },
      );
      const secrets = { bad: corrupt === 'credential' ? { apiKey: 42 } : credential };
      put(
        runtime,
        'provider-profiles.secrets.local.json',
        version === 1 ? { providers: { anthropic: secrets } } : { profiles: secrets },
      );
      assert.deepEqual(Object.keys(readCatalogAccounts(workspace)), ['good']);
      assert.throws(() => resolveByAccountRef(workspace, 'bad'), /malformed|invalid/i);
    });
  }
}

for (const allRejected of [false, true]) {
  test(`startup reports divergent accounts without exiting (allRejected=${allRejected})`, async () => {
    const metadata = {
      claude: { authType: 'oauth', models: ['claude-opus-4-6'] },
      ...(allRejected ? {} : { good: account }),
    };
    put(workspace, 'accounts.json', metadata);
    put(runtime, 'accounts.json', { claude: { authType: 'oauth', models: ['claude-opus-4-6', 'claude-opus-4-7'] } });
    const { accountStartupHook } = await import('../dist/config/account-startup.js');
    const result = accountStartupHook(workspace);
    assert.equal(result.accountCount, allRejected ? 0 : 1);
    assert.equal(result.unavailableAccounts[0].accountRef, 'claude');
    assert.match(result.unavailableAccounts[0].reason, /divergent/);
    assert.throws(() => resolveByAccountRef(workspace, 'claude'), /divergent/);
  });
}

test('ACP registry construction skips a rejected account and still constructs a healthy member', async () => {
  put(workspace, 'accounts.json', { bad: account, good: account });
  put(workspace, 'credentials.json', { good: credential });
  put(runtime, 'accounts.json', { bad: { ...account, models: ['different'] } });
  const { createAcpServiceForConfig } = await import(
    '../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js'
  );
  const poolRegistry = new Map();
  const config = {
    id: 'fixture-acp',
    name: 'fixture',
    displayName: 'fixture',
    color: { primary: '#111111', secondary: '#eeeeee' },
    avatar: '/fixture.png',
    mentionPatterns: ['@fixture-acp'],
    roleDescription: 'fixture',
    clientId: 'acp',
    defaultModel: 'fixture',
    mcpSupport: false,
  };
  const input = {
    projectRoot: workspace,
    profileId: config.id,
    effectiveModel: 'fixture',
    acpConfig: { command: 'mock-acp', startupArgs: ['--acp'] },
    poolRegistry,
    log: { info() {}, warn() {} },
  };
  try {
    assert.equal(await createAcpServiceForConfig({ ...input, config: { ...config, accountRef: 'bad' } }), null);
    assert.equal(poolRegistry.size, 0);
    assert.ok(await createAcpServiceForConfig({ ...input, config: { ...config, accountRef: 'good' } }));
    assert.equal(poolRegistry.size, 1);
  } finally {
    await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll()));
  }
});

afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetMigrationState();
  rmSync(root, { recursive: true, force: true });
});

for (const origin of ['canonical', 'legacy', 'both-equal']) {
  test(`${origin} pair resolves identically from workspace, runtime and runtime API cwd`, () => {
    if (origin !== 'legacy') pair(workspace);
    if (origin !== 'canonical') pair(runtime);
    for (const dir of [workspace, runtime, join(runtime, 'packages/api')]) {
      const profile = resolveByAccountRef(dir, 'fixture');
      assert.equal(profile?.apiKey, credential.apiKey);
      assert.equal(profile?.baseUrl, account.baseUrl);
      assert.equal(resolveForClient(dir, 'anthropic', 'fixture')?.apiKey, credential.apiKey);
    }
  });
}

test('ordinary catalog reads project legacy metadata without creating or modifying files', () => {
  put(workspace, 'cat-catalog.json', { version: 2, accounts: { fixture: account }, breeds: [] });
  put(workspace, 'credentials.json', { fixture: credential });
  const before = readFileSync(join(workspace, '.cat-cafe/cat-catalog.json'), 'utf8');
  assert.equal(readCatalogAccounts(workspace).fixture.baseUrl, account.baseUrl);
  assert.equal(existsSync(join(workspace, '.cat-cafe/accounts.json')), false);
  assert.equal(readFileSync(join(workspace, '.cat-cafe/cat-catalog.json'), 'utf8'), before);
});

test('identical orphan credentials in both roots are still torn', () => {
  for (const dir of [workspace, runtime]) put(dir, 'credentials.json', { fixture: credential });
  assert.throws(() => resolveByAccountRef(runtime, 'fixture'), /torn/);
});

for (const origin of ['legacy', 'both-equal']) {
  test(`editing ${origin} accounts requires reconciliation before any write`, () => {
    pair(runtime);
    if (origin === 'both-equal') pair(workspace);
    const previous = readFileSync(join(runtime, '.cat-cafe/accounts.json'), 'utf8');
    assert.throws(() => writeCatalogAccount(runtime, 'fixture', { ...account, displayName: 'Changed' }), /reconcile/);
    assert.equal(readFileSync(join(runtime, '.cat-cafe/accounts.json'), 'utf8'), previous);
    assert.equal(existsSync(join(workspace, '.cat-cafe/accounts.json')), origin === 'both-equal');
  });
}

for (const version of [1, 2, 3]) {
  test(`legacy v${version} metadata and secrets are projected together without migration`, () => {
    const profile = { id: 'fixture', ...account, mode: 'api_key' };
    put(
      runtime,
      'provider-profiles.json',
      version === 1
        ? { version, providers: { anthropic: { profiles: [profile] } } }
        : { version, providers: [profile] },
    );
    put(
      runtime,
      'provider-profiles.secrets.local.json',
      version === 1
        ? { version, providers: { anthropic: { fixture: credential } } }
        : { version, profiles: { fixture: credential } },
    );
    assert.equal(resolveByAccountRef(workspace, 'fixture')?.apiKey, credential.apiKey);
    assert.equal(readCatalogAccounts(runtime).fixture.clientId, 'anthropic');
    for (const dir of [workspace, runtime]) {
      assert.equal(existsSync(join(dir, '.cat-cafe/accounts.json')), false);
      assert.equal(existsSync(join(dir, '.cat-cafe/credentials.json')), false);
    }
  });
}

for (const reverse of [false, true]) {
  test(`torn pair fails closed in either direction (${reverse}) without leaking its secret`, () => {
    put(reverse ? runtime : workspace, 'accounts.json', { fixture: account });
    put(reverse ? workspace : runtime, 'credentials.json', { fixture: credential });
    for (const dir of [workspace, runtime]) {
      assert.throws(
        () => resolveByAccountRef(dir, 'fixture'),
        (error) => /torn/.test(error.message) && !error.message.includes(credential.apiKey),
      );
    }
  });
}

for (const field of ['clientId', 'envVars', 'apiKey', 'baseUrl']) {
  test(`divergent ${field} fails closed; it never guesses the authoritative store`, () => {
    pair(workspace);
    pair(
      runtime,
      field === 'apiKey'
        ? account
        : { ...account, [field]: field === 'envVars' ? { FIXTURE: 'different' } : 'different' },
      field === 'apiKey' ? { apiKey: 'OTHER_FAKE_KEY' } : credential,
    );
    assert.throws(() => resolveByAccountRef(workspace, 'fixture'), /divergent/);
  });
}

test('canonical equality includes legacy auth normalization and unordered metadata', () => {
  pair(workspace, { authType: 'oauth', displayName: 'Fixture', models: ['a', 'b'], clientId: 'openai' });
  pair(runtime, { authType: 'subscription', displayName: ' Fixture ', models: ['b', 'a', 'a'], clientId: 'openai' });
  assert.equal(resolveByAccountRef(runtime, 'fixture')?.authType, 'oauth');
});

for (const bad of [
  null,
  { authType: 'api_key', models: 42 },
  { authType: 'bogus' },
  { authType: 'api_key', envVars: { BAD: 2 } },
]) {
  test(`malformed requested account ${JSON.stringify(bad)} is not absence`, () => {
    pair(workspace, bad);
    assert.throws(() => resolveByAccountRef(runtime, 'fixture'), /malformed|invalid/);
  });
}

test('malformed credential remains an error, and ordinary reads never make a backup', () => {
  pair(workspace, account, { apiKey: 42 });
  assert.throws(() => resolveByAccountRef(runtime, 'fixture'), /malformed|invalid/);
  writeFileSync(join(workspace, '.cat-cafe/accounts.json'), 'broken JSON');
  assert.throws(() => readCatalogAccounts(workspace), /malformed|invalid/);
  assert.equal(existsSync(join(workspace, '.cat-cafe/accounts.json.bak')), false);
});

test('trimmed global override collapses topology to one store', () => {
  pair(workspace);
  pair(runtime, { ...account, baseUrl: 'https://different.invalid' });
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = ` ${workspace} `;
  assert.equal(resolveByAccountRef(runtime, 'fixture')?.apiKey, credential.apiKey);
  assert.equal(resolveByAccountRef(runtime, 'fixture')?.baseUrl, account.baseUrl);
});

for (const failure of ['divergent', 'torn', 'malformed', 'orphan']) {
  test(`rejected Anthropic alias (${failure}) blocks installer fallback when claude is absent`, () => {
    put(workspace, 'accounts.json', {
      'installer-anthropic': account,
      ...(failure === 'orphan'
        ? {}
        : { builtin_anthropic: failure === 'malformed' ? { authType: 'broken' } : account }),
    });
    put(workspace, 'credentials.json', {
      'installer-anthropic': credential,
      ...(failure === 'torn' ? {} : { builtin_anthropic: credential }),
    });
    if (failure === 'divergent') {
      put(runtime, 'accounts.json', { builtin_anthropic: { ...account, models: ['different'] } });
      put(runtime, 'credentials.json', { builtin_anthropic: credential });
    }
    if (failure === 'torn') put(runtime, 'credentials.json', { builtin_anthropic: credential });
    assert.throws(
      () => resolveAnthropicRuntimeProfile(workspace),
      (error) => /divergent|torn|malformed|orphan/.test(error.message) && !error.message.includes(credential.apiKey),
    );
  });
}

test('installer-only fallback survives unrelated rejected accounts, but a healthy builtin alias blocks it', () => {
  put(workspace, 'accounts.json', { 'installer-anthropic': account, unrelated: { authType: 'broken' } });
  put(workspace, 'credentials.json', { 'installer-anthropic': credential });
  assert.equal(resolveAnthropicRuntimeProfile(workspace).apiKey, credential.apiKey);
  put(workspace, 'accounts.json', { 'installer-anthropic': account, builtin_anthropic: { authType: 'oauth' } });
  assert.equal(resolveAnthropicRuntimeProfile(workspace).apiKey, undefined);
});

test('mutating a rejected ref returns its diagnostic, while an absent ref stays not found', async () => {
  pair(workspace);
  pair(runtime, { ...account, models: ['different'] });
  const before = readFileSync(join(workspace, '.cat-cafe/accounts.json'), 'utf8');
  const Fastify = (await import('fastify')).default;
  const { accountsRoutes } = await import('../dist/routes/accounts.js');
  const app = Fastify();
  await app.register(accountsRoutes);
  const headers = { 'x-cat-cafe-user': 'fixture-owner' };
  try {
    for (const method of ['PATCH', 'DELETE']) {
      const rejected = await app.inject({
        method,
        url: '/api/accounts/fixture',
        headers,
        payload: method === 'PATCH' ? { displayName: 'Updated' } : {},
      });
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.match(rejected.json().error, /divergent/);
      assert.equal(rejected.body.includes(credential.apiKey), false);
    }
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/accounts/absent',
      headers,
      payload: { displayName: 'Updated' },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(readFileSync(join(workspace, '.cat-cafe/accounts.json'), 'utf8'), before);
  } finally {
    await app.close();
  }
});
