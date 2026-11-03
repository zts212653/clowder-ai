import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { getAcpConfig } from '../../dist/config/cat-config-loader.js';
import { prepareInvocationExecutionBinding } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { ExecutionAdmissionConflict } from '../../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { isolateAccountAuthEnvironment } from '../helpers/account-auth-environment.js';

for (const change of ['startup-args', 'removed', 'damaged', 'unchanged', 'after-freeze']) {
  test(`catalog ACP launch source handles ${change} without mixing a new binding with an old pool`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/acp-catalog-source');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    const previous = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    const all = catRegistry.getAllConfigs(),
      catId = 'acp-catalog-source';
    const config = {
      ...all.codex,
      id: catId,
      clientId: 'acp',
      carrier: 'acp',
      configurationSource: 'native_tool',
      accountRef: undefined,
      mcpSupport: false,
      defaultModel: '',
    };
    catRegistry.register(catId, config);
    t.after(() => {
      if (previous === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previous;
      catRegistry.reset();
      Object.entries(all).forEach(([id, member]) => catRegistry.register(id, member));
    });
    const templatePath = join(root, 'cat-template.json');
    const before = { command: process.execPath, startupArgs: ['--before'], mcpWhitelist: [] };
    const write = (acp) =>
      writeFileSync(
        templatePath,
        JSON.stringify({ breeds: [{ id: 'fixture', variants: [{ id: 'default', catId, acp }] }] }),
      );
    write(before);
    assert.deepEqual(getAcpConfig(catId, root), before, 'the test must read the real catalog/template owner');
    const pools = new Map(),
      services = [];
    t.after(() => Promise.all(services.map((service) => service.disposeHostService())));
    const build = async () => {
      const service = await createAcpServiceForConfig({
        projectRoot: root,
        profileId: catId,
        config,
        effectiveModel: '',
        acpConfig: getAcpConfig(catId, root),
        resolveCurrentAcpConfig: () => getAcpConfig(catId, root),
        bootstrapRoot: join(root, 'bootstrap'),
        poolRegistry: pools,
        log: { info() {}, warn() {} },
      });
      assert.ok(service);
      services.push(service);
      return service;
    };
    const service = await build();
    const capture = (current) =>
      prepareInvocationExecutionBinding(
        { threadStore: null, apiUrl: 'http://127.0.0.1:13004' },
        { catId, service: current, threadId: 'thread', userId: 'owner' },
      );
    const mutate = () => {
      if (change === 'damaged') writeFileSync(templatePath, '{');
      else if (change === 'removed') write(null);
      else write({ ...before, startupArgs: ['--after'] });
    };
    if (!['unchanged', 'after-freeze'].includes(change)) {
      mutate();
      await assert.rejects(capture(service), ExecutionAdmissionConflict);
      assert.equal(pools.get(catId).getMetrics().coldStartCount, 0);
      if (change === 'startup-args') {
        await service.disposeHostService();
        const next = await build();
        await capture(next);
        assert.deepEqual(pools.get(catId).clientFactory().config.args, ['--after']);
      } else assert.equal(getAcpConfig(catId, root), undefined);
      return;
    }
    const binding = await capture(service);
    if (change === 'after-freeze') mutate();
    assert.deepEqual(binding.providerOptions.frozenAcpMcpServers, []);
    assert.deepEqual(pools.get(catId).clientFactory().config.args, ['--before']);
    assert.equal(pools.get(catId).getMetrics().coldStartCount, 0);
  });
}
