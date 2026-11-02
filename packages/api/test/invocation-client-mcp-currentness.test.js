import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { ClaudeAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { KimiAgentService } from '../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { ExecutionAdmissionConflict } from '../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

['claude', 'kimi', 'opencode'].forEach((client) => ensureFakeCliOnPath(client));
const cases = ['acp', 'claude', 'kimi', 'opencode']
  .flatMap((client) => ['changed', 'appeared'].map((change) => ({ client, change })))
  .concat([{ client: 'kimi', change: 'native-home' }]);

for (const { client, change } of cases) {
  test(`${client} ${change} MCP source is checked after the final admission wait`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/client-mcp-currentness');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    const host = join(root, 'host'),
      project = join(root, 'project'),
      nativeHome = join(root, 'native-home');
    const mcpServerPath = join(host, 'packages/mcp-server/dist/index.js');
    [join(host, '.cat-cafe'), join(host, 'packages/mcp-server/dist'), join(project, '.git'), nativeHome].forEach(
      (path) => mkdirSync(path, { recursive: true }),
    );
    copyFileSync(process.env.CAT_TEMPLATE_PATH, join(host, 'cat-template.json'));
    writeFileSync(mcpServerPath, '// never executed');
    writeFileSync(join(host, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [] }));
    const keys = [
      'CAT_CAFE_CONFIG_ROOT',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'CAT_CAFE_PROJECT_ALLOWED_ROOTS',
      'CAT_CAFE_MCP_SERVER_PATH',
      'KIMI_CODE_HOME',
    ];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = host;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    process.env.CAT_CAFE_MCP_SERVER_PATH = mcpServerPath;
    process.env.KIMI_CODE_HOME = nativeHome;
    const all = catRegistry.getAllConfigs(),
      catId = 'client-mcp-currentness';
    catRegistry.register(catId, {
      ...all[client === 'claude' ? 'opus' : client === 'kimi' ? 'kimi' : 'codex'],
      id: catId,
      clientId: client === 'claude' ? 'anthropic' : client,
      carrier: client === 'acp' ? 'acp' : 'cli',
      mcpSupport: true,
      accountRef: client === 'opencode' ? 'owned-opencode' : undefined,
      configurationSource: client === 'opencode' ? 'managed_account' : 'native_tool',
      provider: client === 'opencode' ? 'fixture-provider' : undefined,
      defaultModel: client === 'opencode' ? 'fixture-provider/fixture-model' : '',
      cli: { effort: '' },
    });
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([id, member]) => catRegistry.register(id, member));
    });
    if (client === 'opencode') writeCatalogAccount(host, 'owned-opencode', { clientId: 'opencode', authType: 'oauth' });
    const sourcePath =
      change === 'native-home'
        ? join(nativeHome, 'mcp.json')
        : join(project, client === 'opencode' ? 'opencode.json' : '.mcp.json');
    const write = (marker) =>
      writeFileSync(
        sourcePath,
        JSON.stringify(
          client === 'opencode'
            ? { mcp: { userSource: { type: 'local', command: [process.execPath, `--${marker}`] } } }
            : {
                mcpServers: {
                  [change === 'native-home' ? `native_${marker}` : 'userSource']: {
                    command: process.execPath,
                    args: [`--${marker}`],
                  },
                },
              },
        ),
      );
    if (change !== 'appeared') write('before');
    const options = { catId, mcpServerPath };
    const service =
      client === 'claude'
        ? new ClaudeAgentService(options)
        : client === 'kimi'
          ? new KimiAgentService(options)
          : client === 'opencode'
            ? new OpenCodeAgentService(options)
            : new AcpAgentService({
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
      threadStore: {
        get() {
          if (++reads === 2) write('after');
          return { id: 'thread', projectPath: project, createdBy: 'owner' };
        },
      },
    };
    const prepare = () =>
      prepareInvocationExecutionBinding(deps, { catId, service, threadId: 'thread', userId: 'owner' });
    await assert.rejects(prepare(), ExecutionAdmissionConflict);
    const next = await prepare();
    if (client === 'acp')
      assert.deepEqual(next.providerOptions.frozenAcpMcpServers.find((s) => s.name === 'userSource').args, ['--after']);
    else if (client === 'claude')
      assert.deepEqual(next.providerOptions.frozenNativeMcpConfig.servers.userSource.args, ['--after']);
    else if (client === 'opencode') assert.equal(next.openCodeMcpConfig.mcp.userSource.command.at(-1), '--after');
    else {
      const servers = next.providerOptions.frozenKimiMcpConfig.mcpConfig.servers;
      if (change === 'native-home') assert.equal(servers.native_after.enabled, false);
      else assert.deepEqual(servers.userSource.args, ['--after']);
    }
  });
}
