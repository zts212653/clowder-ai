import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ClaudeAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { ClaudeBgCarrierService } from '../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js';
import { ClaudeInteractivePtyCarrierService } from '../dist/domains/cats/services/agents/providers/ClaudeInteractivePtyCarrierService.js';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { CarrierHealthStore } from '../dist/domains/cats/services/agents/providers/carrier-health.js';
import { FallbackCarrierWrapper } from '../dist/domains/cats/services/agents/providers/claude-carrier-factory.js';
import { prepareClaudeSdkLaunch } from '../dist/domains/cats/services/agents/providers/claude-sdk-launch.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  createMockArchive,
  createMockProcess,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

ensureFakeCliOnPath('claude');

for (const scenario of [
  'capabilities',
  'project-mcp',
  'plugin-mcp',
  'carrier-wrapper',
  'agent-sdk',
  'background',
  'interactive-pty',
  'read-only',
]) {
  test(`native Claude uses admitted MCP configuration: ${scenario}`, async (t) => {
    const artifacts = join(process.cwd(), 'artifacts', 'role-agent-refactor', 'native-mcp-freeze');
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, 'fixture-'));
    const host = join(root, 'host');
    const project = join(root, 'project');
    const mcpServerPath = join(host, 'packages', 'mcp-server', 'dist', 'index.js');
    mkdirSync(join(host, '.cat-cafe'), { recursive: true });
    mkdirSync(join(host, 'packages', 'mcp-server', 'dist'), { recursive: true });
    mkdirSync(project);
    copyFileSync(process.env.CAT_TEMPLATE_PATH, join(host, 'cat-template.json'));
    writeFileSync(mcpServerPath, '// not executed');
    t.diagnostic(`retained isolated native MCP fixture: ${root}`);
    const all = catRegistry.getAllConfigs();
    const id = 'native-mcp-freeze';
    catRegistry.register(id, { ...all.opus, id, configurationSource: 'native_tool', accountRef: undefined });
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_PROJECT_ALLOWED_ROOTS', 'MCP_FREEZE_FIXTURE'];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    process.env.MCP_FREEZE_FIXTURE = 'before';
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([key, value]) => catRegistry.register(key, value));
    });
    const pluginId = 'fixture-plugin';
    const capabilityId = scenario === 'plugin-mcp' ? `plugin:${pluginId}:native` : 'fixture-server';
    const serverName = capabilityId.replaceAll(':', '__');
    let marker = 'before';
    const writeConfig = (value) => {
      marker = value;
      const server = { command: process.execPath, args: [`--fixture=${value}`], env: { FIXTURE_SCOPE: value } };
      writeFileSync(
        join(host, '.cat-cafe', 'capabilities.json'),
        JSON.stringify({
          version: scenario === 'plugin-mcp' ? 2 : 1,
          capabilities:
            scenario === 'project-mcp'
              ? []
              : [
                  {
                    id: capabilityId,
                    type: 'mcp',
                    enabled: true,
                    globalEnabled: true,
                    ...(scenario === 'plugin-mcp' ? { source: 'plugin', pluginId } : {}),
                    mcpServer:
                      scenario === 'plugin-mcp' ? { ...server, args: ['--fixture=formal-unselected'] } : server,
                  },
                ],
        }),
      );
      if (scenario === 'project-mcp')
        writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { [serverName]: server } }));
    };
    writeConfig('before');
    const proc = createMockProcess();
    let launchedServers;
    let launchedArgs;
    const spawnFn = mock.fn((_command, args) => {
      launchedArgs = args;
      const index = args.indexOf('--mcp-config');
      if (index >= 0) launchedServers = JSON.parse(readFileSync(args[index + 1], 'utf8')).mcpServers;
      setImmediate(() => {
        if (scenario === 'background') {
          proc.stdout.end('backgrounded · abcd1234\n');
          proc._emitter.emit('close', 0);
        } else void emitEvents(proc, [{ type: 'result', subtype: 'success' }]);
      });
      return proc;
    });
    let service =
      scenario === 'agent-sdk'
        ? new ClaudeSdkAgentService({ runtimeResolver: claudeSdkRuntimeFixture, catId: id, mcpServerPath })
        : new ClaudeAgentService({
            catId: id,
            spawnFn,
            mcpServerPath,
            l0CompilerFn: buildFakeL0Compiler(),
            rawArchive: createMockArchive(),
          });
    if (scenario === 'background')
      service = new ClaudeBgCarrierService({ catId: id, spawnFn, mcpServerPath, l0CompilerFn: buildFakeL0Compiler() });
    if (scenario === 'interactive-pty')
      service = new ClaudeInteractivePtyCarrierService({
        catId: id,
        mcpServerPath,
        hookSidecarPathOverride: join(root, 'never-started.jsonl'),
        driverFactory: ({ extraArgs }) => {
          launchedArgs = extraArgs;
          launchedServers = JSON.parse(
            readFileSync(extraArgs[extraArgs.indexOf('--mcp-config') + 1], 'utf8'),
          ).mcpServers;
          return { start: async () => assert.fail('pre-aborted fixture started native PTY') };
        },
      });
    const invocationService =
      scenario === 'carrier-wrapper'
        ? new FallbackCarrierWrapper(service, id, 'print_sdk', 'print_sdk', new CarrierHealthStore())
        : service;
    const deps = {
      apiUrl: 'http://127.0.0.1:13004',
      threadStore: { get: () => ({ id: 'thread', projectPath: project, createdBy: 'owner' }) },
      ...(scenario === 'plugin-mcp'
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
                    env: {
                      FIXTURE_SCOPE: '${MCP_FREEZE_FIXTURE}',
                      CLOWDER_PLUGIN_ACTION_TOKEN: 'owned-fixture-action',
                    },
                  },
                },
              ],
            }),
          }
        : {}),
    };
    const toolExecutionPolicy = scenario === 'read-only' ? { mode: 'read_only', replayDeniedToolNames: [] } : undefined;
    const binding = await prepareInvocationExecutionBinding(deps, {
      catId: id,
      threadId: 'thread',
      userId: 'owner',
      service: invocationService,
      toolExecutionPolicy,
    });
    writeConfig('after');
    process.env.MCP_FREEZE_FIXTURE = 'after';
    const options = {
      ...binding.providerOptions,
      frozenL0Input: binding.frozenL0Input,
      executionPreferences: binding.executionPreferences,
      workingDirectory: binding.workspace.workingDirectory,
      toolExecutionPolicy,
      callbackEnv: {
        CAT_CAFE_CAT_ID: id,
        CAT_CAFE_API_URL: 'http://127.0.0.1:1',
        CAT_CAFE_INVOCATION_ID: 'current-invocation',
        CAT_CAFE_CALLBACK_TOKEN: 'current-fixture-token',
      },
    };
    if (scenario === 'agent-sdk') {
      const launch = await prepareClaudeSdkLaunch({
        runtime: claudeSdkRuntimeFixture(),
        catId: id,
        model: 'claude-sonnet-4-6',
        prompt: 'isolated task',
        mcpServerPath,
        l0CompilerFn: buildFakeL0Compiler(),
        abortController: new AbortController(),
        options,
      });
      launchedServers = JSON.parse(readFileSync(launch.sdkOptions.extraArgs['mcp-config'], 'utf8')).mcpServers;
    } else if (scenario === 'background') {
      const result = await invocationService.startJob('isolated task', options);
      assert.equal(result.shortId, 'abcd1234');
      assert.equal(spawnFn.mock.calls.length, 1);
    } else if (scenario === 'interactive-pty') {
      const messages = await Array.fromAsync(
        invocationService.invoke('isolated task', { ...options, signal: AbortSignal.abort() }),
      );
      assert.equal(messages.at(-1).type, 'done');
      assert.match(messages.find((message) => message.type === 'error').error, /cancelled before start/);
    } else {
      const messages = await Array.fromAsync(invocationService.invoke('isolated task', options));
      assert.deepEqual(
        messages.filter((message) => message.type === 'error'),
        [],
      );
      assert.equal(spawnFn.mock.calls.length, 1);
    }
    if (scenario === 'read-only') {
      assert.equal(launchedServers, undefined);
      assert.equal(launchedArgs[launchedArgs.indexOf('--tools') + 1], '');
      assert.equal(
        binding.providerOptions?.frozenNativeMcpConfig,
        undefined,
        'read-only admission must not discover unused tools',
      );
    } else {
      assert.deepEqual(launchedServers[serverName].args, ['--fixture=before']);
      assert.equal(launchedServers[serverName].env.FIXTURE_SCOPE, 'before');
      if (scenario === 'plugin-mcp') {
        assert.equal(launchedServers[serverName].env.CAT_CAFE_INVOCATION_ID, 'current-invocation');
        assert.equal(launchedServers[serverName].env.CAT_CAFE_CALLBACK_TOKEN, 'current-fixture-token');
      }
      assert.ok(Object.isFrozen(binding.providerOptions.frozenNativeMcpConfig.servers));
    }
  });
}
