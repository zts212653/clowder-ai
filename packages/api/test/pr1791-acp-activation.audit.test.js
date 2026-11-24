import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { createAcpServiceForConfig } from '../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';

test('an existing ACP member stays callable after normal native MCP activation', async (t) => {
  const directory = resolve('artifacts/pr1791-activation');
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'case-'));
  const initialEnvironment = new Set(Object.keys(process.env));
  const admission = {
    instance: { pluginInstanceId: 'audit-1791-plugin', activationState: 'enabled' },
    packageRecord: { manifest: { contributions: [{ type: 'mcp', id: 'audit-native' }] } },
  };
  const actions = new NativePluginActions(async () => admission);
  const pools = new Map();
  const services = [];
  const originalMembers = catRegistry.getAllConfigs();
  t.after(async () => {
    actions.deactivateAll();
    Object.keys(process.env).filter((key) => !initialEnvironment.has(key) && key.startsWith('CLOWDER_PLUGIN_'))
      .forEach((key) => { delete process.env[key]; });
    await Promise.all(services.map((service) => service.disposeHostService()));
    await Promise.all([...pools.values()].map((pool) => pool.closeAll()));
    catRegistry.reset();
    Object.entries(originalMembers).forEach(([id, member]) => catRegistry.register(id, member));
  });
  const profileId = 'audit-1791-existing-acp';
  const config = {
    ...catRegistry.getAllConfigs().codex, id: profileId, clientId: 'acp',
    configurationSource: 'native_tool', accountRef: undefined, defaultModel: '', mcpSupport: false,
  };
  catRegistry.register(profileId, config);
  const capture = (service) => prepareInvocationExecutionBinding({
    threadStore: { get: () => ({ id: 'audit-thread', createdBy: 'default-user', projectPath: root }) },
    apiUrl: 'http://127.0.0.1:3102',
  }, { catId: profileId, service, userId: 'default-user', threadId: 'audit-thread', ownerAuthProvenance: 'strict' });
  const build = async () => {
    const service = await createAcpServiceForConfig({
      projectRoot: root, profileId, config, effectiveModel: '',
      acpConfig: { command: process.execPath, startupArgs: [] }, poolRegistry: pools,
      log: { info() {}, warn() {} },
    });
    assert.ok(service);
    services.push(service);
    return service;
  };
  const service = await build();
  await capture(service);
  actions.activate(admission, actions.generation('audit-1791-plugin'), async () => ({}));
  const addedKeys = Object.keys(process.env).filter((key) => !initialEnvironment.has(key));
  const attempts = await Promise.allSettled([0, 1, 2].map(() =>
    capture(service)));
  const rebuilt = await build();
  await capture(rebuilt);
  const result = {
    platform: process.platform, node: process.version, realProviderStarted: false,
    initialCapture: 'fulfilled', addedEnvironmentKeys: addedKeys,
    repeatedCapture: attempts.map((attempt) => attempt.status === 'fulfilled'
      ? { status: attempt.status }
      : { status: attempt.status, error: attempt.reason.message }),
    rebuiltCapture: 'fulfilled',
  };
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
  t.diagnostic(JSON.stringify(result));
  assert.deepEqual(attempts.map((attempt) => attempt.status), ['fulfilled', 'fulfilled', 'fulfilled']);
});
