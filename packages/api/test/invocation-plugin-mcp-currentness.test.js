import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { ExecutionAdmissionConflict } from '../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { NativeMcpLaunches } from '../dist/domains/plugin/declared/native-mcp-launches.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

for (const change of ['refresh', 'disable', 'enable', 'generation-only', 'unchanged', 'already-denied']) {
  test(`Host admission checks the actual plugin activation owner: ${change}`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/plugin-mcp-currentness');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    const host = join(root, 'host'),
      project = join(root, 'project');
    const serverPath = join(host, 'packages/mcp-server/dist/index.js');
    [join(host, '.cat-cafe'), join(host, 'packages/mcp-server/dist'), join(project, '.git')].forEach((path) => {
      mkdirSync(path, { recursive: true });
    });
    copyFileSync(process.env.CAT_TEMPLATE_PATH, join(host, 'cat-template.json'));
    writeFileSync(serverPath, '// not executed');
    const pluginId = 'test.plugin.currentness',
      instanceId = 'owned-plugin-activation';
    const policy = { id: `plugin:${pluginId}:tools`, type: 'mcp', source: 'plugin', pluginId, enabled: true };
    writeFileSync(
      join(host, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [{ ...policy, mcpServer: { command: process.execPath, args: ['--formal'] } }],
      }),
    );
    const keys = [
      'CAT_CAFE_CONFIG_ROOT',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'CAT_CAFE_PROJECT_ALLOWED_ROOTS',
      'CAT_CAFE_MCP_SERVER_PATH',
    ];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = host;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    process.env.CAT_CAFE_MCP_SERVER_PATH = serverPath;
    const all = catRegistry.getAllConfigs(),
      catId = 'plugin-mcp-currentness';
    catRegistry.register(catId, {
      ...all.codex,
      id: catId,
      clientId: 'acp',
      carrier: 'acp',
      mcpSupport: true,
      configurationSource: 'native_tool',
      accountRef: undefined,
      defaultModel: '',
      cli: { effort: '' },
    });
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([id, member]) => {
        catRegistry.register(id, member);
      });
    });
    const admission = {
      instance: {
        pluginInstanceId: instanceId,
        pluginId,
        activationState: 'enabled',
        lifecycleState: 'installed',
        configReadiness: 'ready',
        packageDigest: 'fixture-package',
      },
      packageRecord: { packageState: 'installed', manifest: { contributions: [{ type: 'mcp', id: 'tools' }] } },
    };
    const currentAdmission = async () =>
      structuredClone(
        change === 'already-denied'
          ? { ...admission, instance: { ...admission.instance, activationState: 'disabled' } }
          : admission,
      );
    const actions = new NativePluginActions(currentAdmission);
    const launches = new NativeMcpLaunches(currentAdmission, actions);
    t.after(() => {
      launches.deactivateAll();
      actions.deactivateAll();
    });
    const activate = (marker) =>
      launches.activate(admission, actions.generation(instanceId), [
        {
          contributionId: 'tools',
          installationPolicy: policy,
          server: { command: process.execPath, args: [`--${marker}`], env: {}, workingDirectory: project },
        },
      ]);
    if (change !== 'enable') activate('before');
    const service = new AcpAgentService({
      catId,
      clientId: 'acp',
      projectRoot: host,
      mcpSupport: true,
      mcpWhitelist: [],
      pool: {},
      poolKey: { projectPath: host, providerProfile: catId },
    });
    let reads = 0;
    const deps = {
      apiUrl: 'http://127.0.0.1:13004',
      resolveInvocationPluginMcpView: () => launches.memberView(project),
      threadStore: {
        get() {
          if (++reads === 2) {
            if (['refresh', 'disable', 'generation-only'].includes(change)) actions.deactivate(instanceId);
            if (['refresh', 'disable'].includes(change)) launches.deactivate(instanceId);
            if (['refresh', 'enable'].includes(change)) activate('after');
          }
          return { id: 'thread', projectPath: project, createdBy: 'owner' };
        },
      },
    };
    const prepare = () =>
      prepareInvocationExecutionBinding(deps, {
        catId,
        service,
        threadId: 'thread',
        userId: 'owner',
        ownerAuthProvenance: 'strict',
      });
    if (['unchanged', 'already-denied'].includes(change)) {
      const binding = await prepare();
      const server = binding.providerOptions.frozenAcpMcpServers.find((item) => item.name === policy.id);
      if (change === 'unchanged') assert.deepEqual(server.args, ['--before']);
      else assert.equal(server, undefined);
    } else {
      await assert.rejects(prepare(), ExecutionAdmissionConflict);
      const binding = await prepare();
      const server = binding.providerOptions.frozenAcpMcpServers.find((item) => item.name === policy.id);
      if (['refresh', 'enable'].includes(change)) assert.deepEqual(server.args, ['--after']);
      else assert.equal(server, undefined);
    }
  });
}
