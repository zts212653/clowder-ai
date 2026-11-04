import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { writeCatalogAccount } from '../../dist/config/catalog-accounts.js';
import { writeCredential } from '../../dist/config/credentials.js';
import { prepareInvocationExecutionBinding } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { ExecutionAdmissionConflict } from '../../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';

for (const change of ['home', 'env', 'credential', 'quota', 'after-binding', 'account-selection', 'native-selection']) {
  test(`factory ACP account source handles a ${change} write at admission`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/acp-account-source');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT'];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => {
      process.env[key] = root;
    });
    const all = catRegistry.getAllConfigs(),
      catId = 'acp-account-source';
    const config = {
      ...all.codex,
      id: catId,
      clientId: 'acp',
      defaultModel: 'fixture-model',
      configurationSource: 'managed_account',
      accountRef: 'owned-acp',
      mcpSupport: false,
    };
    catRegistry.register(catId, config);
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([id, member]) => catRegistry.register(id, member));
    });
    const account = {
      clientId: 'acp',
      authType: change === 'credential' ? 'api_key' : 'oauth',
      envVars: {
        HOME: join(root, 'before'),
        FIXTURE_ORDINARY: 'before',
        ...(change === 'credential' ? { FIXTURE_TOKEN: '${api_key}' } : {}),
      },
    };
    writeCatalogAccount(root, 'owned-acp', account);
    if (change === 'credential') writeCredential('owned-acp', { apiKey: 'fixture-before-only' }, root);
    const pools = new Map();
    const factoryInput = {
      projectRoot: root,
      profileId: catId,
      config,
      effectiveModel: 'fixture-model',
      acpConfig: { command: process.execPath, startupArgs: ['--fixture-acp'] },
      bootstrapRoot: join(root, 'bootstrap'),
      poolRegistry: pools,
      log: { info() {}, warn() {} },
    };
    const service = await createAcpServiceForConfig(factoryInput);
    assert.ok(service);
    const view = service.forInvocation();
    t.after(async () => {
      await view.releaseInvocation();
      await service.disposeHostService();
    });
    const pool = pools.get(catId);
    const launch = pool.clientFactory().config;
    assert.equal(launch.env.HOME, join(root, 'before'));
    const mutate = () => {
      if (change === 'account-selection' || change === 'native-selection') {
        if (change === 'account-selection')
          writeCatalogAccount(root, 'other-owned-acp', { ...account, envVars: { HOME: join(root, 'after') } });
        const members = catRegistry.getAllConfigs();
        catRegistry.reset();
        Object.entries(members).forEach(([id, member]) =>
          catRegistry.register(
            id,
            id === catId
              ? {
                  ...member,
                  accountRef: change === 'account-selection' ? 'other-owned-acp' : undefined,
                  configurationSource: change === 'native-selection' ? 'native_tool' : 'managed_account',
                }
              : member,
          ),
        );
        return;
      }
      if (change === 'credential') writeCredential('owned-acp', { apiKey: 'fixture-after-only' }, root);
      else
        writeCatalogAccount(root, 'owned-acp', {
          ...account,
          ...(change === 'quota'
            ? { quota: { status: 'unsupported', source: 'codex_official_readonly', items: [], observedAt: Date.now() } }
            : {
                envVars: {
                  ...account.envVars,
                  ...(change === 'env' ? { FIXTURE_ORDINARY: 'after' } : { HOME: join(root, 'after') }),
                },
              }),
        });
    };
    if (change !== 'after-binding') mutate();
    const pending = prepareInvocationExecutionBinding(
      { threadStore: null, apiUrl: 'http://127.0.0.1:13004' },
      { catId, service: view, threadId: 'thread', userId: 'owner' },
    );
    if (!['quota', 'after-binding'].includes(change)) {
      await assert.rejects(
        pending,
        (error) => error instanceof ExecutionAdmissionConflict && !/fixture-(before|after)-only/.test(error.message),
      );
      assert.equal(pool.getMetrics().coldStartCount, 0);
      await view.releaseInvocation();
      await service.disposeHostService();
      const replacement = await createAcpServiceForConfig({
        ...factoryInput,
        config: catRegistry.tryGet(catId).config,
      });
      assert.ok(replacement);
      t.after(() => replacement.disposeHostService());
      const next = await prepareInvocationExecutionBinding(
        { threadStore: null, apiUrl: 'http://127.0.0.1:13004' },
        { catId, service: replacement, threadId: 'thread', userId: 'owner' },
      );
      const nextLaunch = pools.get(catId).clientFactory().config;
      if (change === 'native-selection') {
        assert.equal(next.resolvedAccount, null);
        assert.equal(nextLaunch.env, undefined);
        return;
      }
      assert.equal(nextLaunch.env.HOME, next.accountEnv.HOME);
      if (change !== 'account-selection')
        assert.equal(nextLaunch.env.FIXTURE_ORDINARY, change === 'env' ? 'after' : 'before');
      if (change === 'account-selection') assert.equal(next.effectiveAccountRef, 'other-owned-acp');
      if (change === 'home') assert.equal(nextLaunch.env.HOME, join(root, 'after'));
      if (change === 'credential') assert.equal(nextLaunch.env.FIXTURE_TOKEN, 'fixture-after-only');
      return;
    }
    const binding = await pending;
    assert.equal(binding.accountEnv.HOME, join(root, 'before'));
    if (change === 'after-binding') mutate();
    let starts = 0;
    pool.clientFactory = () => ({
      isAlive: true,
      agentCapabilities: {},
      promptCapabilities: {},
      async initialize() {
        starts++;
        return {};
      },
      async newSession() {
        return { sessionId: 'owned-account-session' };
      },
      async *promptStream() {
        yield {
          sessionId: 'owned-account-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'owned-account-reply' } },
        };
        return 'end_turn';
      },
      onCapacity() {},
      offCapacity() {},
      clearRecentCapacitySignal() {},
      isSessionSafeForReuse() {
        return true;
      },
      async close() {},
    });
    const messages = await Array.fromAsync(
      view.invoke('owned task', {
        ...binding.providerOptions,
        executionPreferences: binding.executionPreferences,
      }),
    );
    assert.deepEqual(
      messages.filter((m) => m.type === 'error'),
      [],
    );
    assert.ok(messages.some((m) => m.type === 'text' && m.content === 'owned-account-reply'));
    assert.equal(starts, 1);
    assert.equal(launch.env.HOME, join(root, 'before'));
  });
}
