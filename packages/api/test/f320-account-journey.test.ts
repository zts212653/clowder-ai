import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { readAccountStoreSnapshot } from '../src/config/account-store-snapshot.js';
import { toAllCatConfigs } from '../src/config/cat-config-loader.js';
import { readRuntimeCatCatalog } from '../src/config/runtime-cat-catalog.js';
import { invokeSingleCat } from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { accountsRoutes } from '../src/routes/accounts.js';

test('real account routes persist login, note, quota and atomically switch a local family while excluding cloud', async () => {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'f320-journey-'));
  Object.assign(process.env, {
    HOME: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
    AUDIT_LOG_DIR: join(root, 'audit'),
  });
  delete process.env.CODEX_HOME;
  delete process.env.CAT_CAFE_RUNTIME_ROOT;
  mkdirSync(join(root, '.cat-cafe'));
  const variant = (id: string) => ({
    id: `${id}-default`,
    catId: id,
    clientId: 'openai',
    defaultModel: 'fixture',
    mcpSupport: true,
    accountRef: 'codex',
    mentionPatterns: [`@${id}`],
    cli: { command: 'codex', outputFormat: 'json' },
  });
  writeFileSync(
    join(root, '.cat-cafe', 'cat-catalog.json'),
    JSON.stringify({
      version: 2,
      breeds: [
        {
          id: 'maine',
          catId: 'local-a',
          name: '缅因猫',
          displayName: '缅因猫',
          avatar: '/avatars/codex.png',
          color: { primary: '#123456', secondary: '#abcdef' },
          mentionPatterns: ['@local-a'],
          roleDescription: 'fixture',
          defaultVariantId: 'local-a-default',
          variants: [variant('local-a'), variant('local-b')],
        },
      ],
      roster: {
        'local-a': { family: 'maine', roles: ['assistant'], lead: false, available: true, evaluation: 'fixture' },
        'local-b': { family: 'maine', roles: ['assistant'], lead: false, available: true, evaluation: 'fixture' },
      },
      reviewPolicy: {
        requireDifferentFamily: false,
        preferActiveInThread: false,
        preferLead: false,
        excludeUnavailable: true,
      },
      coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
    }),
  );
  writeFileSync(join(root, 'cat-template.json'), readFileSync(join(root, '.cat-cafe', 'cat-catalog.json')));
  const originalRegistry = catRegistry.getAllConfigs();
  catRegistry.reset();
  for (const [id, config] of Object.entries(toAllCatConfigs(readRuntimeCatCatalog(root))))
    catRegistry.register(id, config);
  const startedConfig = catRegistry.getOrThrow('local-a').config;
  type Options = NonNullable<Parameters<Parameters<typeof invokeSingleCat>[1]['service']['invoke']>[1]>;
  const launches: Options[] = [];
  let releaseStarted!: () => void;
  let admittedStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    admittedStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  let invocationNumber = 0;
  const deps = {
    registry: {
      create: async () => ({ invocationId: `fixture-${++invocationNumber}`, callbackToken: 'fixture' }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => root,
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:0',
  } as unknown as Parameters<typeof invokeSingleCat>[0];
  const service = {
    async *invoke(_prompt: string, options: Options) {
      launches.push(options);
      if (launches.length === 1) {
        admittedStarted();
        await release;
      }
      yield {
        type: 'metadata',
        catId: 'local-a',
        timestamp: Date.now(),
        metadata: { sessionId: `fixture-${launches.length}` },
      };
      yield { type: 'done', catId: 'local-a', timestamp: Date.now() };
    },
  } as unknown as Parameters<typeof invokeSingleCat>[1]['service'];
  async function invoke(threadId: string) {
    const messages = [];
    for await (const message of invokeSingleCat(deps, {
      catId: 'local-a' as Parameters<typeof invokeSingleCat>[1]['catId'],
      service,
      prompt: 'fixture',
      userId: 'fixture',
      threadId,
      isLastCat: true,
    }))
      messages.push(message);
    return messages;
  }
  let quotaCalls = 0;
  const app = Fastify();
  await app.register(accountsRoutes, {
    loginDriver: {
      async run(input) {
        input.onReady();
        const identity = { userId: 'user-b', workspaceId: 'workspace-b', email: 'b@example.test' };
        mkdirSync(input.home, { recursive: true });
        const jwt = `x.${Buffer.from(JSON.stringify({ email: identity.email, 'https://api.openai.com/auth': { chatgpt_user_id: identity.userId, chatgpt_account_id: identity.workspaceId } })).toString('base64url')}.x`;
        writeFileSync(
          join(input.home, 'auth.json'),
          JSON.stringify({
            tokens: { id_token: jwt, account_id: identity.workspaceId, access_token: 'fixture-access-b' },
          }),
        );
        return identity;
      },
    },
    quotaFetcher: (async (url, options) => {
      quotaCalls++;
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer fixture-access-b');
      assert.equal(options?.redirect, 'error');
      return new Response(
        JSON.stringify({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000 } } }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  const request = async (url: string, payload: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST') => {
    const response = await app.inject({
      url,
      method,
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, ...payload },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  try {
    const { profile } = await request('/api/accounts', { authType: 'oauth', clientId: 'openai', displayName: '公司' });
    const unavailable = await app.inject({
      url: `/api/accounts/${profile.id}/codex/binding/preview`,
      method: 'POST',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, catId: 'local-a', scope: 'family' },
    });
    assert.equal(unavailable.statusCode, 409);
    await request(`/api/accounts/${profile.id}/codex/login/start`, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readAccountStoreSnapshot(root).resolve(profile.id).account?.codex?.attempt?.state, 'success');
    await request(`/api/accounts/${profile.id}`, { displayName: '工作' }, 'PATCH');
    const quota = await request(`/api/accounts/${profile.id}/codex/quota`, {});
    assert.equal(quota.quota.items[0].usedPercent, 30);
    assert.equal(quotaCalls, 1);
    const preview = await request(`/api/accounts/${profile.id}/codex/binding/preview`, {
      catId: 'local-a',
      scope: 'family',
    });
    assert.equal(preview.targets.length, 2);
    const inFlight = invoke('before-binding');
    await Promise.race([
      started,
      inFlight.then(() => {
        throw new Error('invocation never reached service');
      }),
    ]);
    assert.equal(launches[0].executionAccount?.accountRef, 'codex');
    await request(`/api/accounts/${profile.id}/codex/binding/commit`, {
      catId: 'local-a',
      scope: 'family',
      previewToken: preview.previewToken,
    });
    const cats = toAllCatConfigs(readRuntimeCatCatalog(root));
    assert.equal(cats['local-a'].accountRef, profile.id);
    assert.equal(cats['local-b'].accountRef, profile.id);
    assert.equal(catRegistry.getOrThrow('local-a').config.accountRef, profile.id);
    assert.equal(catRegistry.getOrThrow('local-b').config.accountRef, profile.id);
    assert.equal(startedConfig.accountRef, 'codex', 'accepted invocation/Realtime config remains A');
    const after = await invoke('after-binding');
    assert.equal(launches[1].codexAccountLaunch?.accountRef, profile.id);
    assert.equal(launches[1].executionAccount?.accountRef, profile.id);
    assert.equal(
      after.find((message) => message.type === 'metadata')?.metadata?.executionAccount?.accountRef,
      profile.id,
    );
    assert.equal(
      launches[0].executionAccount?.accountRef,
      'codex',
      'remembered Realtime/control options keep original A',
    );
    releaseStarted();
    const completed = await inFlight;
    assert.equal(
      completed.find((message) => message.type === 'metadata')?.metadata?.executionAccount?.accountRef,
      'codex',
    );
    const cloud = await app.inject({
      url: `/api/accounts/${profile.id}/codex/binding/preview`,
      method: 'POST',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, catId: 'gpt-pro', scope: 'family' },
    });
    assert.equal(cloud.statusCode, 409);
    const stale = await app.inject({
      url: `/api/accounts/${profile.id}/codex/binding/commit`,
      method: 'POST',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: root, catId: 'local-a', scope: 'family', previewToken: preview.previewToken },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(readAccountStoreSnapshot(root).resolve(profile.id).account?.quota?.status, 'ok');
    assert.equal(readAccountStoreSnapshot(root).resolve(profile.id).account?.displayName, '工作');
    assert.ok(readFileSync(join(root, '.cat-cafe', 'accounts.json'), 'utf8').includes('workspace-b'));
  } finally {
    releaseStarted?.();
    await app.close();
    catRegistry.reset();
    for (const [id, config] of Object.entries(originalRegistry)) catRegistry.register(id, config);
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
