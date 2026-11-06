import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { materializeSessionMcpServers } from '../../dist/domains/cats/services/agents/providers/acp/acp-session-env.js';
import { NativePluginActions } from '../../dist/domains/plugin/declared/native-plugin-actions.js';

for (const [clientId, transport] of [
  ['kimi', 'stdio'],
  ['opencode', 'stdio'],
  ['acp', 'httpstream'],
])
  test(`${clientId}/${transport} admission survives real plugin activation without changing its process plan`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'acp-plugin-startup-'));
    const profileId = `plugin-startup-${clientId}`;
    const pools = new Map();
    const services = [];
    const input = {
      projectRoot: root,
      bootstrapRoot: join(root, 'bootstrap'),
      profileId,
      config: {
        ...catRegistry.getAllConfigs().codex,
        id: profileId,
        clientId,
        provider: clientId === 'opencode' ? 'anthropic' : clientId,
        configurationSource: 'native_tool',
        accountRef: undefined,
        mcpSupport: false,
      },
      effectiveModel: 'fixture-model',
      acpConfig: { command: process.execPath, startupArgs: [], transport, experimental: transport === 'httpstream' },
      poolRegistry: pools,
      log: { info() {}, warn() {} },
    };
    const admission = {
      instance: { pluginInstanceId: `isolated-${profileId}` },
      packageRecord: { manifest: { contributions: [{ type: 'mcp', id: 'isolated-mcp' }] } },
    };
    const actions = new NativePluginActions(async () => admission);
    const keysBefore = new Set(Object.keys(process.env));
    t.after(async () => {
      actions.deactivateAll();
      for (const key of Object.keys(process.env)) if (!keysBefore.has(key)) delete process.env[key];
      await Promise.allSettled(services.map((service) => service.disposeHostService()));
      await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll()));
      rmSync(root, { recursive: true, force: true });
    });
    const create = async () => {
      const service = await createAcpServiceForConfig(input);
      assert.ok(service);
      services.push(service);
      return service;
    };
    const service = await create();
    const options = { workingDirectory: root, mcpSupport: false };
    await service.captureInvocationOptions(options);
    const originalPool = pools.get(profileId);
    actions.activate(admission, 0, async () => undefined);
    const references = actions.environmentReferences(admission.instance.pluginInstanceId, 'isolated-mcp');
    const hostKeys = Object.values(references).map((reference) => reference.slice(2, -1));
    assert.equal(hostKeys.length, 2);
    assert.ok(
      hostKeys.every((key) => process.env[key]),
      'real plugin activation must publish its host references',
    );
    await service.captureInvocationOptions(options);
    await service.captureInvocationOptions(options);
    const refreshed = await create();
    await refreshed.captureInvocationOptions(options);
    assert.equal(pools.get(profileId), originalPool, 'host-only plugin references cannot change ACP process identity');
    const client = originalPool.clientFactory();
    assert.ok(hostKeys.every((key) => client.config.preparedEnv[key] === undefined));
    const selected = actions.environment(admission.instance.pluginInstanceId, 'isolated-mcp');
    const [server] = materializeSessionMcpServers([
      {
        name: 'selected-plugin',
        hostSource: 'plugin',
        command: process.execPath,
        args: [],
        env: Object.entries(references).map(([name, value]) => ({ name, value })),
      },
    ]);
    assert.ok(
      server.env.some(({ name, value }) => name === 'CLOWDER_PLUGIN_ACTION_TOKEN' && value === selected[name]),
      'the selected MCP server must still receive the current Host connection through its reference',
    );
  });
