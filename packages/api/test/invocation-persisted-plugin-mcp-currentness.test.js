import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { ExecutionAdmissionConflict } from '../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { fixture } from './helpers/alpha-plugin-runtime-fixture.js';
import { directMcpContract } from './helpers/direct-mcp-contract.js';

for (const deployment of ['runtime', 'alpha']) {
  for (const change of ['unchanged', 'generation-only', 'refresh']) {
    test(`${deployment} member admission checks the real MCP activation owner: ${change}`, async (t) => {
      t.after(isolateAccountAuthEnvironment());
      const f = await fixture(t, deployment);
      await f.mutate(true);
      const host = f.capabilityProjectRoot;
      const serverPath = join(host, 'packages/mcp-server/dist/index.js');
      mkdirSync(join(serverPath, '..'), { recursive: true });
      copyFileSync(process.env.CAT_TEMPLATE_PATH, join(host, 'cat-template.json'));
      writeFileSync(serverPath, '// never executed');
      const keys = [
        'CAT_CAFE_CONFIG_ROOT',
        'CAT_CAFE_GLOBAL_CONFIG_ROOT',
        'CAT_CAFE_PROJECT_ALLOWED_ROOTS',
        'CAT_CAFE_MCP_SERVER_PATH',
      ];
      const old = new Map(keys.map((key) => [key, process.env[key]]));
      process.env.CAT_CAFE_CONFIG_ROOT = host;
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = host;
      process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = join(host, '..');
      process.env.CAT_CAFE_MCP_SERVER_PATH = serverPath;
      const all = catRegistry.getAllConfigs();
      const catId = 'persisted-plugin-currentness';
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
      const prepare = () =>
        prepareInvocationExecutionBinding(
          {
            apiUrl: 'http://127.0.0.1:13004',
            resolveInvocationPluginMcpView: () => f.runtime.supervisor.resolveMemberMcpView(),
            threadStore: {
              async get() {
                if (++reads === 2) {
                  if (change === 'generation-only')
                    f.runtime.supervisor.nativeActions.deactivate(f.installed.pluginInstanceId);
                  if (change === 'refresh') await f.runtime.supervisor.configRefresh(f.installed.pluginInstanceId);
                }
                return { id: 'thread', projectPath: f.projectRoot, createdBy: 'owner' };
              },
            },
          },
          { catId, service, threadId: 'thread', userId: 'owner', ownerAuthProvenance: 'strict' },
        );
      const capabilityId = `plugin:${f.pluginId}:native`;
      if (change === 'unchanged') {
        const binding = await prepare();
        const selected = binding.providerOptions.frozenAcpMcpServers.find((item) => item.name === capabilityId);
        const launch = await f.runtime.supervisor.resolveNativeMcpLaunch({
          mode: 'plugin_native',
          pluginInstanceId: f.installed.pluginInstanceId,
          contributionId: 'native',
        });
        const token = directMcpContract(selected).upstream.env.CLOWDER_PLUGIN_ACTION_TOKEN;
        assert.equal(token, launch.env.CLOWDER_PLUGIN_ACTION_TOKEN);
        await f.mutate(false);
        assert.equal(directMcpContract(selected).upstream.env.CLOWDER_PLUGIN_ACTION_TOKEN, token);
        const disabled = await prepare();
        assert.equal(
          disabled.providerOptions.frozenAcpMcpServers.some((item) => item.name === capabilityId),
          false,
        );
        await f.mutate(true);
        const next = await prepare();
        assert.equal(
          directMcpContract(next.providerOptions.frozenAcpMcpServers.find((item) => item.name === capabilityId))
            .upstream.env.CLOWDER_PLUGIN_ACTION_TOKEN,
          token,
        );
      } else {
        await assert.rejects(prepare(), ExecutionAdmissionConflict);
        const next = await prepare();
        const selected = next.providerOptions.frozenAcpMcpServers.find((item) => item.name === capabilityId);
        assert.equal(Boolean(selected), change === 'refresh');
      }
    });
  }
}
