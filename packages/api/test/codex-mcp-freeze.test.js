import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { codexConfigObjectFromArgs } from '../dist/domains/cats/services/agents/providers/codex-config-overrides.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { callMcpProbe, writeMcpProbe } from './helpers/mcp-probe.js';
import {
  buildFakeL0Compiler,
  createMockArchive,
  createMockProcess,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

for (const source of ['capabilities', 'http-bearer', 'plugin-mcp']) {
  test(`Codex actual launch retains admitted ${source} MCP configuration`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const artifacts = join(process.cwd(), 'artifacts', 'role-agent-refactor', 'codex-mcp-freeze');
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, 'fixture-'));
    const host = join(root, 'host');
    const project = join(root, 'project');
    mkdirSync(join(host, '.cat-cafe'), { recursive: true });
    mkdirSync(join(project, '.git'), { recursive: true });
    copyFileSync(process.env.CAT_TEMPLATE_PATH, join(host, 'cat-template.json'));
    const keys = [
      'CAT_CAFE_CONFIG_ROOT',
      'CAT_CAFE_PROJECT_ALLOWED_ROOTS',
      'CODEX_MCP_FREEZE_TOKEN',
      'CODEX_MCP_FREEZE_ENV',
    ];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    process.env.CODEX_MCP_FREEZE_TOKEN = 'owned-bearer-before';
    process.env.CODEX_MCP_FREEZE_ENV = 'before';
    const all = catRegistry.getAllConfigs();
    const id = 'codex-mcp-freeze';
    catRegistry.register(id, {
      ...all.codex,
      id,
      accountRef: undefined,
      configurationSource: 'native_tool',
      defaultModel: 'fixture-model',
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
    const probePath = join(root, 'native-probe.mjs');
    writeMcpProbe(
      probePath,
      `return {
      scope: process.env.FIXTURE_SCOPE,
      invocation: JSON.parse(readFileSync(process.env.CAT_CAFE_CREDENTIAL_FILE, 'utf8')).invocationId,
      action: process.env.CLOWDER_PLUGIN_ACTION_TOKEN,
    };`,
    );
    const capabilityId = source === 'plugin-mcp' ? `plugin:${pluginId}:native` : 'fixture-server';
    const serverName = capabilityId.replaceAll(':', '__');
    let marker;
    const writeConfig = (value) => {
      marker = value;
      writeFileSync(
        join(host, '.cat-cafe', 'capabilities.json'),
        JSON.stringify({
          version: source === 'plugin-mcp' ? 2 : 1,
          capabilities: [
            {
              id: capabilityId,
              type: 'mcp',
              enabled: true,
              globalEnabled: true,
              ...(source === 'plugin-mcp' ? { source: 'plugin', pluginId } : {}),
              mcpServer:
                source === 'http-bearer'
                  ? {
                      transport: 'streamableHttp',
                      url: 'https://example.invalid/mcp',
                      headers: { aUtHoRiZaTiOn: 'Bearer ${CODEX_MCP_FREEZE_TOKEN}' },
                    }
                  : {
                      command: process.execPath,
                      args: [`--fixture=${source === 'plugin-mcp' ? 'formal-unselected' : value}`],
                      env: { FIXTURE_SCOPE: value },
                    },
            },
          ],
        }),
      );
    };
    writeConfig('before');
    let launched;
    const service = new CodexAgentService({
      catId: id,
      carrierMode: 'exec_json',
      cliCommand: process.execPath,
      l0CompilerFn: buildFakeL0Compiler(),
      rawArchive: createMockArchive(),
      spawnFn: (_command, args, options) => {
        const proc = createMockProcess();
        delete proc.pid;
        launched = { server: codexConfigObjectFromArgs(args).mcp_servers[serverName], env: options.env };
        setImmediate(
          () =>
            void emitEvents(proc, [
              { type: 'thread.started', thread_id: 'owned-codex-thread' },
              { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'owned-fixture-reply' } },
              { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
            ]),
        );
        return proc;
      },
    });
    const deps = {
      apiUrl: 'http://127.0.0.1:13004',
      threadStore: { get: () => ({ id: 'thread', projectPath: project, createdBy: 'owner' }) },
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
                    args: [probePath, `--fixture=${marker}`],
                    transport: 'stdio',
                    workingDir: host,
                    env: {
                      FIXTURE_SCOPE: '${CODEX_MCP_FREEZE_ENV}',
                      CLOWDER_PLUGIN_ACTION_TOKEN: 'owned-fixture-action',
                    },
                  },
                },
              ],
            }),
          }
        : {}),
    };
    const binding = await prepareInvocationExecutionBinding(deps, {
      catId: id,
      threadId: 'thread',
      userId: 'owner',
      service,
    });
    const admittedPlan = JSON.stringify(binding.providerOptions.frozenCodexMcpInput);
    writeConfig('after');
    process.env.CODEX_MCP_FREEZE_TOKEN = 'owned-bearer-after';
    process.env.CODEX_MCP_FREEZE_ENV = 'after';
    const credentialFile = join(root, 'current-callback.json');
    writeFileSync(
      credentialFile,
      JSON.stringify({ invocationId: 'current-invocation', callbackToken: 'owned-current-callback' }),
    );
    const launchOptions = {
      ...binding.providerOptions,
      executionPreferences: binding.executionPreferences,
      frozenL0Input: binding.frozenL0Input,
      workingDirectory: project,
      callbackEnv: {
        CAT_CAFE_CAT_ID: id,
        CAT_CAFE_INVOCATION_ID: 'current-invocation',
        CAT_CAFE_CALLBACK_TOKEN: 'owned-current-callback',
        CAT_CAFE_CREDENTIAL_FILE: credentialFile,
        CAT_CAFE_MCP_TRANSPORT: 'stdio',
      },
    };
    const messages = await Array.fromAsync(service.invoke('isolated task', launchOptions));
    assert.deepEqual(
      messages.filter((message) => message.type === 'error'),
      [],
    );
    assert.ok(messages.some((message) => message.type === 'text' && message.content === 'owned-fixture-reply'));
    if (source === 'http-bearer')
      assert.equal(launched.env[launched.server.bearer_token_env_var], 'owned-bearer-before');
    else {
      const spec = JSON.parse(readFileSync(launched.server.args[1], 'utf8'));
      assert.deepEqual(spec.args, [...(source === 'plugin-mcp' ? [probePath] : []), '--fixture=before']);
      assert.equal(spec.env.FIXTURE_SCOPE, 'before');
      if (source === 'plugin-mcp') {
        assert.equal(launched.server.env.CAT_CAFE_CREDENTIAL_FILE, credentialFile);
        const firstWrapper = launched.server.args[0];
        assert.deepEqual(await callMcpProbe(launched.server), {
          scope: 'before',
          invocation: 'current-invocation',
          action: 'owned-fixture-action',
        });
        const nextFile = join(root, 'next-callback.json');
        writeFileSync(
          nextFile,
          JSON.stringify({ invocationId: 'next-invocation', callbackToken: 'owned-next-callback' }),
        );
        const nextMessages = await Array.fromAsync(
          service.invoke('next isolated task', {
            ...launchOptions,
            callbackEnv: {
              ...launchOptions.callbackEnv,
              CAT_CAFE_CREDENTIAL_FILE: nextFile,
              CAT_CAFE_INVOCATION_ID: 'next-invocation',
              CAT_CAFE_CALLBACK_TOKEN: 'owned-next-callback',
            },
          }),
        );
        assert.deepEqual(
          nextMessages.filter((message) => message.type === 'error'),
          [],
        );
        assert.notEqual(
          launched.server.args[0],
          firstWrapper,
          'one-shot wrappers must be recreated for a later launch',
        );
        assert.deepEqual(await callMcpProbe(launched.server), {
          scope: 'before',
          invocation: 'next-invocation',
          action: 'owned-fixture-action',
        });
      } else assert.equal(spec.env.CAT_CAFE_CALLBACK_TOKEN, undefined);
    }
    assert.equal(JSON.stringify(binding.providerOptions.frozenCodexMcpInput), admittedPlan);
  });
}
