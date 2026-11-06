import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { configStore } from '../../dist/config/ConfigStore.js';
import { InvocationServiceScope } from '../../dist/domains/cats/services/agents/invocation/invocation-service-scope.js';
import { prepareInvocationExecutionBinding } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { agentServiceGeneration } from '../../dist/domains/cats/services/agents/registry/AgentRegistry.js';

test('stale ACP admission rebuilds its source before the one configuration retry', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'acp-admission-refresh-'));
  const catId = 'acp-refresh-kimi';
  const configs = catRegistry.getAllConfigs();
  const config = {
    ...configs.codex,
    id: catId,
    clientId: 'kimi',
    carrier: 'acp',
    provider: 'kimi',
    defaultModel: 'fixture-model',
    configurationSource: 'native_tool',
    accountRef: undefined,
    mcpSupport: false,
  };
  catRegistry.register(catId, config);
  const oldTimeout = process.env.CLI_TIMEOUT_MS;
  const timeout = oldTimeout === '12345' ? '12346' : '12345';
  const pools = new Map();
  const services = [];
  const warnings = [];
  const scope = new InvocationServiceScope();
  t.after(async () => {
    await scope.dispose();
    await Promise.allSettled(services.map((service) => service.disposeHostService()));
    await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll()));
    configStore.reset();
    if (oldTimeout === undefined) delete process.env.CLI_TIMEOUT_MS;
    else process.env.CLI_TIMEOUT_MS = oldTimeout;
    catRegistry.reset();
    Object.entries(configs).forEach(([id, value]) => catRegistry.register(id, value));
    rmSync(root, { recursive: true, force: true });
  });
  const create = async () => {
    const service = await createAcpServiceForConfig({
      projectRoot: root,
      bootstrapRoot: join(root, 'bootstrap'),
      profileId: catId,
      config,
      effectiveModel: 'fixture-model',
      acpConfig: { command: process.execPath, startupArgs: [], transport: 'stdio' },
      poolRegistry: pools,
      log: {
        info() {},
        warn(fields) {
          warnings.push(fields);
        },
      },
    });
    assert.ok(service);
    services.push(service);
    return service;
  };
  let current = await create();
  const originalPool = pools.get(catId);
  const pinned = scope.pin(current);
  const capture = (service) =>
    prepareInvocationExecutionBinding(
      { threadStore: null, apiUrl: 'http://127.0.0.1:13004' },
      { catId, threadId: 'fixture-thread', userId: 'owner', service, workingDirectory: root },
    );
  await capture(pinned);
  configStore.set('cli.timeoutMs', timeout);
  let refreshed = 0;
  const admitted = await scope.admit(
    pinned,
    () => current,
    capture,
    undefined,
    async () => {
      refreshed++;
      current = await create();
    },
  );
  assert.equal(refreshed, 1, 'a fresh pin of the same stale factory cannot recover admission');
  assert.notEqual(agentServiceGeneration(admitted.service), agentServiceGeneration(pinned));
  assert.notEqual(pools.get(catId), originalPool, 'the refreshed factory must own the new frozen process plan');
  assert.equal(pools.get(catId).clientFactory().config.preparedEnv.CLI_TIMEOUT_MS, timeout);
  assert.ok(admitted.executionBinding);
  assert.ok(warnings.some((entry) => entry.changedEnvironmentKeys?.includes('CLI_TIMEOUT_MS')));
  assert.ok(!JSON.stringify(warnings).includes(timeout), 'diagnostics must never retain environment values');
});
