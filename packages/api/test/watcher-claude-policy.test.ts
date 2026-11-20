import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCatId } from '@cat-cafe/shared';
import { ToolExecutionPolicyUnavailableError } from '../src/domains/cats/services/agents/invocation/tool-execution-policy.js';
import { ClaudeAgentService } from '../src/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { CarrierHealthStore } from '../src/domains/cats/services/agents/providers/carrier-health.js';
import { FallbackCarrierWrapper } from '../src/domains/cats/services/agents/providers/claude-carrier-factory.js';
import { prepareClaudeSdkLaunch } from '../src/domains/cats/services/agents/providers/claude-sdk-launch.js';
import type { AgentService, AgentServiceOptions } from '../src/domains/cats/services/types.js';
import { watcherPanelToolPolicy } from '../src/domains/concierge/watcher/panel/watcher-panel-policy.js';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import { collect, createMockProcess, emitEvents } from './helpers/provider-archive-test-helpers.js';

const previousPath = process.env.PATH;
const cliDirectory = dirname(ensureFakeCliOnPath('claude'));
after(async () => {
  process.env.PATH = previousPath;
  await rm(cliDirectory, { recursive: true, force: true });
});
const mcpServerPath = fileURLToPath(new URL('../../mcp-server/dist/index.js', import.meta.url));
type McpServers = Record<string, { command?: string; env?: Record<string, string> }>;

async function fixture(t: import('node:test').TestContext): Promise<AgentServiceOptions> {
  const root = await mkdtemp(join(tmpdir(), 'watcher-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const servers = Object.fromEntries(
    ['collab', 'memory', 'audio'].map((family) => [
      `cat-cafe-${family}`,
      {
        command: process.execPath,
        args: [fileURLToPath(new URL(`../../mcp-server/dist/${family}.js`, import.meta.url))],
        env: { CAT_CAFE_WATCHER_TOOL_NAMES: 'cat_cafe_get_message' },
      },
    ]),
  );
  return {
    workingDirectory: root,
    sessionId: 'watcher-native-session',
    signal: new AbortController().signal,
    callbackEnv: {
      CAT_CAFE_CAT_ID: 'sonnet',
      CAT_CAFE_USER_ID: 'fixture-owner',
      CAT_CAFE_THREAD_ID: 'fixture-thread',
      CAT_CAFE_INVOCATION_ID: 'fixture-invocation',
      CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
      CAT_CAFE_API_URL: 'http://127.0.0.1:9',
      CAT_CAFE_DATA_DIR: root,
      CAT_CAFE_MCP_TRANSPORT: 'stdio',
    },
    toolExecutionPolicy: watcherPanelToolPolicy(),
    cliConfigArgs: ['--tools', 'Bash,Edit,Write', '--chrome'],
    frozenNativeMcpConfig: {
      source: 'capabilities.json',
      catCafeMcpServerNames: Object.keys(servers),
      pluginMcpServerNames: ['external'],
      servers: { ...servers, external: { command: 'untrusted-external-server', args: [] } },
    },
  };
}

function assertMcpSurface(servers: McpServers) {
  assert.deepEqual(Object.keys(servers).sort(), ['cat-cafe-collab', 'cat-cafe-memory']);
  for (const server of Object.values(servers)) {
    assert.equal(
      server.env?.CAT_CAFE_WATCHER_TOOL_NAMES,
      '',
      'retired bounded protocol cannot enter an ordinary watcher',
    );
    assert.deepEqual(
      JSON.parse(server.env?.CAT_CAFE_ALLOWED_TOOL_NAMES ?? 'null'),
      watcherPanelToolPolicy().allowedToolNames,
    );
  }
}

test('Claude CLI and SDK advertise ordinary watcher readers through their concrete services', () => {
  const services: AgentService[] = [
    new ClaudeAgentService({ catId: createCatId('sonnet') }),
    new ClaudeSdkAgentService({ catId: createCatId('sonnet') }),
  ];
  for (const service of services) {
    assert.equal(service.supportsToolExecutionPolicy?.(watcherPanelToolPolicy()), true);
    assert.deepEqual(service.watcherMemberCapability?.(), { supported: true, context: 'ordinary', readOnly: 'tools' });
  }
});

test('actual SDK launch keeps resume but exposes only the named watcher MCP tools', async (t) => {
  const options = await fixture(t);
  const launch = await prepareClaudeSdkLaunch({
    catId: createCatId('sonnet'),
    model: 'claude-sonnet-5-5',
    prompt: 'Read the working context',
    abortController: new AbortController(),
    runtime: claudeSdkRuntimeFixture(),
    options,
    mcpServerPath,
    l0CompilerFn: async () => 'WATCHER_IDENTITY',
  });
  assert.equal(launch.sdkOptions.permissionMode, 'default');
  assert.equal(launch.sdkOptions.allowedTools, undefined, 'SDK allow patterns must not shadow the per-call decision');
  assert.deepEqual(launch.sdkOptions.tools, []);
  assert.equal(launch.sdkOptions.allowDangerouslySkipPermissions, undefined);
  assert.equal(launch.sdkOptions.resume, 'watcher-native-session');
  assert.notEqual(launch.sdkOptions.persistSession, false);
  assert.deepEqual(launch.sdkOptions.settingSources, []);
  const file = launch.sdkOptions.extraArgs?.['mcp-config'];
  assert.equal(typeof file, 'string');
  assertMcpSurface(JSON.parse(readFileSync(file!, 'utf8')).mcpServers);
  const settings = JSON.parse(String(launch.sdkOptions.settings));
  assert.equal(settings.disableAllHooks, true);
  assert.deepEqual(settings.enabledPlugins, {});
});

test('actual CLI start arguments cannot regain native writers through user flags or resume', async (t) => {
  const options = await fixture(t),
    proc = createMockProcess();
  const observed: { args?: readonly string[]; servers?: McpServers } = {};
  const service = new ClaudeAgentService({
    catId: createCatId('sonnet'),
    model: 'claude-sonnet-5-5',
    mcpServerPath,
    l0CompilerFn: async (input) => {
      await writeFile(input.outPath!, 'WATCHER_IDENTITY');
      return 'WATCHER_IDENTITY';
    },
    spawnFn: (_command, argv) => {
      observed.args = argv ?? [];
      const i = observed.args.indexOf('--mcp-config');
      if (i >= 0) observed.servers = JSON.parse(readFileSync(observed.args[i + 1], 'utf8')).mcpServers;
      return proc;
    },
  });
  const collecting = collect(service.invoke('Read the working context', options));
  await emitEvents(proc, [{ type: 'result', subtype: 'success', result: 'quiet' }]);
  await collecting;
  const args = observed.args!;
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value('--permission-mode'), 'default');
  assert.equal(value('--permission-prompts'), 'none');
  assert.equal(value('--tools'), '');
  assert.equal(value('--setting-sources'), '');
  assert.equal(value('--resume'), 'watcher-native-session');
  assert.ok(!args.includes('--no-session-persistence') && !args.includes('--chrome'));
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-chrome'));
  assertMcpSurface(observed.servers!);
});

test('quota fallback rejects an unsupported carrier before invoking it with watcher credentials', async () => {
  let unsafeCalls = 0;
  const primary: AgentService = {
    async *invoke() {
      throw new Error('You have reached your usage limit. Please wait.');
    },
    supportsToolExecutionPolicy: () => true,
  };
  const unsafe: AgentService = {
    async *invoke() {
      unsafeCalls++;
    },
  };
  const wrapper = new FallbackCarrierWrapper(
    primary,
    createCatId('sonnet'),
    'bg_daemon',
    'bg_daemon',
    new CarrierHealthStore(),
    () => unsafe,
  );
  await assert.rejects(
    () => collect(wrapper.invoke('Read context', { toolExecutionPolicy: watcherPanelToolPolicy() })),
    ToolExecutionPolicyUnavailableError,
  );
  assert.equal(unsafeCalls, 0);
});
