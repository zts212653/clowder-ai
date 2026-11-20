import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { type CatConfig, catRegistry, type TurnExecutionRecord } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import type { IThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { AgentService } from '../src/domains/cats/services/types.js';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { watcherProviderLaunch } from '../src/domains/concierge/watcher/watcher-authority.js';
import { watcherRoutes } from '../src/routes/watcher.js';

let fixtureIndex = 0;
function fixture(t: TestContext, clientId: CatConfig['clientId'], extra: Partial<CatConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'watcher-provider-'));
  const previous = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({
      'watcher-paid': {
        clientId,
        authType: 'api_key',
        baseUrl: 'https://fixture.invalid',
        envVars: { ACCOUNT_ROLE: 'watcher-fixture' },
      },
    }),
  );
  writeFileSync(
    join(root, '.cat-cafe/credentials.json'),
    JSON.stringify({ 'watcher-paid': { apiKey: 'fixture-never-real' } }),
  );
  const id = `watcher-provider-${clientId}-${fixtureIndex++}`;
  catRegistry.register(id, {
    ...catRegistry.getOrThrow('sonnet').config,
    id,
    clientId,
    defaultModel: 'fixture-model',
    accountRef: clientId === 'acp' ? undefined : 'watcher-paid',
    ...extra,
  });
  const threads = { get: () => ({ projectPath: process.cwd() }) } as unknown as IThreadStore;
  const source = { threadId: 'thread', userId: 'owner' } as TurnExecutionRecord;
  return { id, threads, source, root };
}

test('watcher launch retains the selected Anthropic account, model and provider routing', async (t) => {
  const f = fixture(t, 'anthropic');
  const launch = await watcherProviderLaunch(f.threads, f.id, f.source, {}, new AbortController().signal);
  assert.equal(launch.callbackEnv.ANTHROPIC_API_KEY, 'fixture-never-real');
  assert.equal(launch.callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE, 'api_key');
  assert.equal(launch.callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE, 'fixture-model');
  assert.equal(launch.callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL, 'https://fixture.invalid');
  assert.equal(launch.callbackEnv.CODEX_AUTH_MODE, undefined);
  assert.equal(launch.binding.accountEnv?.ACCOUNT_ROLE, 'watcher-fixture');
});

test('watcher launch resolves the native ACP account in the proven workspace', async (t) => {
  const f = fixture(t, 'acp');
  let resolvedAt: string | undefined;
  const service: AgentService = {
    async *invoke() {},
    async resolveScopedNativeAccount(input) {
      resolvedAt = input.workingDirectory;
      return { id: 'dsh-existing', persistedClientId: 'acp', authType: 'api_key', apiKey: 'fixture-native-key' };
    },
  };
  const launch = await watcherProviderLaunch(
    f.threads,
    f.id,
    f.source,
    {},
    new AbortController().signal,
    undefined,
    service,
  );
  assert.equal(resolvedAt, process.cwd());
  assert.equal(launch.binding.executionAccount?.accountRef, 'dsh-existing');
  assert.equal(
    launch.callbackEnv.OPENAI_API_KEY,
    undefined,
    'native ACP credential stays owned by its installed carrier',
  );
});

test('settings offer provider-compatible accounts and reject a foreign account before saving', async (t) => {
  const f = fixture(t, 'anthropic');
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
  });
  await app.register(watcherRoutes, {
    configStore: new MemoryConciergeConfigStore(),
    threadStore: f.threads,
    labelStore: { list: async () => [] },
    turnExecutionStore: new InMemoryTurnExecutionStore(),
    capability: () => ({ supported: true, context: 'ordinary', readOnly: 'tools' }),
  } as never);
  const headers = { host: 'localhost', origin: 'http://localhost:3171' };
  const state = (await app.inject({ url: '/api/watcher/config', headers })).json();
  assert.deepEqual(
    state.members.find((row: { catId: string }) => row.catId === f.id).accounts.map((row: { id: string }) => row.id),
    ['watcher-paid'],
  );
  const routing = (catId: string) => ({
    primary: { catId, accountRef: 'watcher-paid' },
    whenSameFamily: { mode: 'primary' },
    maxConcurrentRuns: 6,
  });
  const foreign = await app.inject({
    method: 'PUT',
    url: '/api/watcher/config',
    headers,
    payload: { expectedRevision: 0, routing: routing('codex') },
  });
  assert.equal(foreign.statusCode, 422);
  const own = await app.inject({
    method: 'PUT',
    url: '/api/watcher/config',
    headers,
    payload: { expectedRevision: 0, routing: routing(f.id) },
  });
  assert.equal(own.statusCode, 200, own.body);
});

test('watcher settings exclude platform accounts and keep native AGY OAuth launchable', async (t) => {
  const f = fixture(t, 'google', { agyProfile: { enabled: true, carrier: 'native', model: 'gemini-4-carbon-high' } });
  writeFileSync(
    join(f.root, '.cat-cafe/accounts.json'),
    JSON.stringify({
      'watcher-paid': { clientId: 'google', authType: 'api_key' },
      gemini: { clientId: 'google', authType: 'oauth' },
      'google-cloud-fixture': {
        clientId: 'google',
        authType: 'oauth',
        googleCloud: { credential: 'local_adc', projectId: 'fixture-project' },
      },
      'google-env-fixture': { clientId: 'google', authType: 'oauth', envVars: { ACCOUNT_ROLE: 'fixture' } },
      'google-base-fixture': { clientId: 'google', authType: 'oauth', baseUrl: 'https://fixture.invalid' },
    }),
  );
  const ordinaryId = `${f.id}-ordinary`;
  catRegistry.register(ordinaryId, { ...catRegistry.getOrThrow(f.id).config, id: ordinaryId, agyProfile: undefined });
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
  });
  await app.register(watcherRoutes, {
    configStore: new MemoryConciergeConfigStore(),
    threadStore: f.threads,
    labelStore: { list: async () => [] },
    turnExecutionStore: new InMemoryTurnExecutionStore(),
    capability: () => ({ supported: true, context: 'ordinary', readOnly: 'tools' }),
  } as never);
  const headers = { host: 'localhost', origin: 'http://localhost:3171' };
  const response = await app.inject({ url: '/api/watcher/config', headers });
  const members: { catId: string; accounts: { id: string }[] }[] = response.json().members;
  assert.deepEqual(
    members.find((row) => row.catId === f.id)?.accounts.map((row) => row.id),
    ['gemini'],
  );
  const ordinary = members.find((row) => row.catId === ordinaryId)?.accounts.map((row) => row.id);
  assert.ok(ordinary?.includes('watcher-paid'), 'ordinary API consumers retain their own account choices');
  assert.ok(!ordinary?.includes('google-cloud-fixture'), 'platform accounts cannot be used by any watcher');
  const save = (catId: string, accountRef: string) =>
    app.inject({
      method: 'PUT',
      url: '/api/watcher/config',
      headers,
      payload: {
        expectedRevision: 0,
        routing: { primary: { catId, accountRef }, whenSameFamily: { mode: 'primary' }, maxConcurrentRuns: 6 },
      },
    });
  for (const accountRef of ['watcher-paid', 'google-cloud-fixture', 'google-env-fixture', 'google-base-fixture']) {
    const rejected = await save(f.id, accountRef);
    assert.equal(rejected.statusCode, 422, accountRef);
    assert.equal(rejected.json().code, 'WATCHER_ACCOUNT_UNAVAILABLE');
  }
  assert.equal((await save(ordinaryId, 'google-cloud-fixture')).statusCode, 422);
  assert.equal((await save(f.id, 'gemini')).statusCode, 200, 'valid native OAuth selection remains usable');
});
