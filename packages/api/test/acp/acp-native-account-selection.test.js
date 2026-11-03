import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { writeCatalogAccount } from '../../dist/config/catalog-accounts.js';
import { prepareInvocationExecutionBinding } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { ExecutionAdmissionConflict } from '../../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';

for (const source of ['native-whitespace', 'legacy-to-native']) {
  test(`actual ACP factory preserves effective ${source} account semantics`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/acp-native-selection');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    t.diagnostic(`retained account fixture; no native process: ${root}`);
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT'];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => {
      process.env[key] = root;
    });
    const all = catRegistry.getAllConfigs(),
      catId = 'acp-native-selection';
    const config = {
      ...all.codex,
      id: catId,
      clientId: 'anthropic',
      mcpSupport: false,
      defaultModel: 'fixture-model',
      configurationSource: source === 'native-whitespace' ? 'native_tool' : undefined,
      accountRef: source === 'native-whitespace' ? ' \t ' : undefined,
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
    writeCatalogAccount(root, 'claude', {
      clientId: 'anthropic',
      authType: 'oauth',
      envVars: { HOME: join(root, 'app-account-home') },
    });
    const pools = new Map(),
      services = [];
    t.after(() => Promise.all(services.map((service) => service.disposeHostService())));
    const build = async (member) => {
      const service = await createAcpServiceForConfig({
        projectRoot: root,
        profileId: catId,
        config: member,
        effectiveModel: 'fixture-model',
        acpConfig: { command: process.execPath, startupArgs: ['--never-start-fixture'] },
        bootstrapRoot: join(root, 'bootstrap'),
        poolRegistry: pools,
        log: { info() {}, warn() {} },
      });
      assert.ok(service);
      services.push(service);
      return service;
    };
    const service = await build(config);
    const capture = (current) =>
      prepareInvocationExecutionBinding(
        { threadStore: null, apiUrl: 'http://127.0.0.1:13004' },
        { catId, service: current, userId: 'owner', threadId: 'thread' },
      );
    const original = await capture(service);
    assert.equal(original.effectiveAccountRef, undefined);
    if (source === 'native-whitespace') {
      assert.equal(original.resolvedAccount, null);
      assert.equal(pools.get(catId).clientFactory().config.env?.HOME, undefined);
      return;
    }
    assert.equal(original.resolvedAccount.id, 'claude');
    assert.equal(pools.get(catId).clientFactory().config.env.HOME, join(root, 'app-account-home'));
    const members = catRegistry.getAllConfigs();
    catRegistry.reset();
    const native = { ...config, configurationSource: 'native_tool', accountRef: undefined };
    Object.entries(members).forEach(([id, member]) => catRegistry.register(id, id === catId ? native : member));
    await assert.rejects(capture(service), ExecutionAdmissionConflict);
    await service.disposeHostService();
    const replacement = await build(native);
    assert.equal((await capture(replacement)).resolvedAccount, null);
    assert.equal(pools.get(catId).clientFactory().config.env?.HOME, undefined);
    assert.equal(pools.get(catId).getMetrics().coldStartCount, 0);
  });
}
