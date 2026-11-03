import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  invokeSingleCat,
  prepareInvocationExecutionBinding,
} from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { OpenCodeAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  createMockArchive,
  createMockProcess,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

ensureFakeCliOnPath('opencode');

for (const source of ['capabilities', 'project-config', 'plugin-mcp', 'mcp-path']) {
  test(`Host OpenCode launch consumes admitted ${source} MCP configuration`, async (t) => {
    const artifacts = join(process.cwd(), 'artifacts', 'role-agent-refactor', 'opencode-mcp-freeze');
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, 'fixture-'));
    const host = join(root, 'host');
    const project = join(root, 'project');
    const mcpServerPath = join(host, 'packages', 'mcp-server', 'dist', 'index.js');
    mkdirSync(join(host, '.cat-cafe'), { recursive: true });
    mkdirSync(join(host, 'packages', 'mcp-server', 'dist'), { recursive: true });
    mkdirSync(project);
    copyFileSync(process.env.CAT_TEMPLATE_PATH, join(host, 'cat-template.json'));
    writeFileSync(mcpServerPath, '// never executed');
    if (source === 'mcp-path')
      writeFileSync(join(host, 'packages', 'mcp-server', 'dist', 'collab.js'), '// never executed');
    const keys = [
      'CAT_CAFE_CONFIG_ROOT',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'CAT_CAFE_PROJECT_ALLOWED_ROOTS',
      'CAT_CAFE_MCP_SERVER_PATH',
      'OPENCODE_MCP_FREEZE',
    ];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = host;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    process.env.CAT_CAFE_MCP_SERVER_PATH = mcpServerPath;
    process.env.OPENCODE_MCP_FREEZE = 'before';
    writeFileSync(
      join(host, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'owned-opencode': { authType: 'oauth', clientId: 'opencode' } }),
    );
    const all = catRegistry.getAllConfigs();
    const id = 'opencode-mcp-freeze';
    catRegistry.register(id, {
      ...all.codex,
      id,
      clientId: 'opencode',
      carrier: 'native',
      accountRef: 'owned-opencode',
      configurationSource: 'managed_account',
      provider: 'fixture-provider',
      defaultModel: 'fixture-provider/fixture-model',
    });
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([key, config]) => catRegistry.register(key, config));
    });
    const pluginId = 'fixture-plugin';
    const capabilityId =
      source === 'plugin-mcp'
        ? `plugin:${pluginId}:native`
        : source === 'mcp-path'
          ? 'cat-cafe-collab'
          : 'fixture-server';
    const serverName = capabilityId.replaceAll(':', '__');
    let marker;
    const writeConfig = (value) => {
      marker = value;
      writeFileSync(
        join(host, '.cat-cafe', 'capabilities.json'),
        JSON.stringify({
          version: source === 'plugin-mcp' ? 2 : 1,
          capabilities:
            source === 'project-config'
              ? []
              : [
                  {
                    id: capabilityId,
                    type: 'mcp',
                    enabled: true,
                    globalEnabled: true,
                    ...(source === 'plugin-mcp' ? { source: 'plugin', pluginId } : {}),
                    ...(source === 'mcp-path' ? { source: 'cat-cafe' } : {}),
                    mcpServer: {
                      command: process.execPath,
                      args: [`--fixture=${source === 'plugin-mcp' ? 'formal-unselected' : value}`],
                      env: { FIXTURE_SCOPE: value },
                    },
                  },
                ],
        }),
      );
      if (source === 'project-config')
        writeFileSync(
          join(project, 'opencode.json'),
          JSON.stringify({
            mcp: {
              [serverName]: {
                type: 'local',
                command: [process.execPath, `--fixture=${value}`],
                environment: { FIXTURE_SCOPE: value },
              },
            },
          }),
        );
    };
    writeConfig('before');
    let launched;
    const proc = createMockProcess();
    // This in-memory fixture has no OS process for Host liveness to sample.
    delete proc.pid;
    const service = new OpenCodeAgentService({
      catId: id,
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
      autoApproveProbeFn: async () => ({ approvalFlag: '--auto', standalone: true, cacheable: true }),
      opencodeDbPath: join(root, 'never-opened.db'),
      opencodeManagedConfigPaths: [],
      spawnFn: (_command, _args, options) => {
        launched = JSON.parse(readFileSync(options.env.OPENCODE_CONFIG, 'utf8'));
        setImmediate(
          () =>
            void emitEvents(proc, [
              {
                type: 'text',
                timestamp: Date.now(),
                sessionID: 'owned-opencode-native',
                part: { type: 'text', text: 'owned-fixture-reply' },
              },
            ]),
        );
        return proc;
      },
    });
    const deps = {
      threadStore: { get: () => ({ id: 'thread', projectPath: project, createdBy: 'owner' }) },
      registry: {
        create: () => ({ invocationId: 'opencode-freeze-invocation', callbackToken: 'owned-fixture' }),
        verify: async () => ({ ok: false }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => project,
      },
      apiUrl: 'http://127.0.0.1:1',
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      ...(source === 'plugin-mcp'
        ? {
            resolveInvocationPluginMcpView: async () => ({
              entries: [
                {
                  capabilityId,
                  pluginId,
                  isCurrent: () => true,
                  server: {
                    command: process.execPath,
                    args: [`--fixture=${marker}`],
                    transport: 'stdio',
                    workingDir: host,
                    env: { FIXTURE_SCOPE: '${OPENCODE_MCP_FREEZE}' },
                  },
                },
              ],
            }),
          }
        : {}),
    };
    const executionBinding = await prepareInvocationExecutionBinding(deps, {
      catId: id,
      threadId: 'thread',
      userId: 'owner',
      service,
    });
    const admittedPlan = structuredClone(executionBinding.openCodeMcpConfig);
    writeConfig('after');
    process.env.OPENCODE_MCP_FREEZE = 'after';
    if (source === 'mcp-path') process.env.CAT_CAFE_MCP_SERVER_PATH = join(root, 'unavailable-new-mcp', 'index.js');
    const messages = await Array.fromAsync(
      invokeSingleCat(deps, {
        catId: id,
        threadId: 'thread',
        userId: 'owner',
        service,
        executionBinding,
        prompt: 'isolated task',
        isLastCat: true,
      }),
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'error'),
      [],
    );
    assert.ok(messages.some((message) => message.type === 'text' && message.content === 'owned-fixture-reply'));
    assert.deepEqual(
      launched.mcp[serverName].command.slice(1),
      source === 'mcp-path' ? [join(host, 'packages', 'mcp-server', 'dist', 'collab.js')] : ['--fixture=before'],
    );
    assert.equal(launched.mcp[serverName].environment.FIXTURE_SCOPE, 'before');
    assert.deepEqual(
      executionBinding.openCodeMcpConfig,
      admittedPlan,
      'materialization must not modify the admitted plan',
    );
    assert.ok(Object.isFrozen(executionBinding.openCodeMcpConfig.mcp));
  });
}
