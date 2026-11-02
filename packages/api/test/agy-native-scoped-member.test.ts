import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { parse } from 'yaml';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { AgyNativeAgentService } from '../src/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { prepareAgyNativeLaunch } from '../src/domains/cats/services/agents/providers/agy-native/agy-native-launch.js';
import type { AgentServiceOptions } from '../src/domains/cats/services/types.js';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-member-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = {
    enabled: true,
    autoApprove: true,
    profileId: 'gemini38',
    homeRoot: join(root, 'profiles'),
    model: 'gemini-3.8-flash-high',
  };
  const settingsPath = join(profile.homeRoot, profile.profileId, '.gemini/antigravity-cli/settings.json');
  mkdirSync(join(settingsPath, '..'), { recursive: true });
  const originalSettings = JSON.stringify({ model: 'other-wall-session-model', trustedWorkspaces: ['/other/wall'] });
  writeFileSync(settingsPath, originalSettings);
  const options: AgentServiceOptions = {
    workingDirectory: workspace,
    signal: new AbortController().signal,
    executionAccount: {
      accountRef: 'existing-oauth',
      displayName: 'Existing',
      authType: 'oauth',
      accountRevision: '1',
    },
    callbackEnv: {
      CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
      CAT_CAFE_INVOCATION_ID: 'member-inv',
      CAT_CAFE_CALLBACK_TOKEN: 'fixture-only',
      CAT_CAFE_THREAD_ID: 'member-thread',
      CAT_CAFE_CAT_ID: 'gemini38',
    },
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'player',
      memberSession: { sessionId: 'member', generation: 1, executionId: 'execution' },
    },
    pluginNativeLaunch: {
      sandbox: { kind: 'scoped-member', workspaceRoot: workspace },
      server: {
        name: 'plugin__dev.clowder.fixture__player',
        command: process.execPath,
        args: ['player.mjs'],
        workingDirectory: workspace,
        env: { FIXTURE_PLAYER: 'only' },
        transport: 'stdio',
      },
      assertCurrent: () => {},
    },
  };
  return { root, workspace, profile, options, settingsPath, originalSettings };
}

test('AGY member launch exposes the exact native MCP and no mounted engineering skills', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, '.agents', 'skills', 'poison'), { recursive: true });
  writeFileSync(join(f.workspace, '.agents/skills/poison/SKILL.md'), 'ENGINEERING-CONTEXT-POISON');
  writeFileSync(join(f.workspace, '.mcp.json'), JSON.stringify({ mcpServers: { foreign: { command: 'false' } } }));
  const plan = await prepareAgyNativeLaunch({
    catId: 'gemini38',
    model: f.profile.model,
    profileConfig: f.profile,
    workspace: f.workspace,
    prompt: 'Observe the game.',
    body: '# Identity\nScoped identity only.',
    command: '/usr/bin/true',
    options: { ...f.options, spawnCliOverride: async function* () {} },
  });
  try {
    const geminiArg = plan.cliOptions.args.find((arg) => arg.startsWith('--gemini_dir='));
    assert.ok(geminiArg);
    const gemini = geminiArg.slice('--gemini_dir='.length);
    const servers = JSON.parse(readFileSync(join(gemini, 'config/mcp_config.json'), 'utf8')).mcpServers;
    assert.deepEqual(Object.keys(servers), ['plugin__dev.clowder.fixture__player']);
    assert.deepEqual(servers['plugin__dev.clowder.fixture__player'], {
      command: process.execPath,
      args: ['player.mjs'],
      cwd: f.workspace,
      env: { FIXTURE_PLAYER: 'only' },
    });
    assert.deepEqual(plan.agentTools, ['call_mcp_tool']);
    assert.ok(!plan.cliOptions.args.includes('--add-dir'), 'member context is supplied through its issued server');
    assert.ok(plan.cliOptions.args.includes('--disable-slash-commands'));
    assert.ok(!plan.cliOptions.args.includes('--dangerously-skip-permissions'));
    const agent = readFileSync(join(gemini, 'config/agents', plan.agentName, 'agent.md'), 'utf8');
    const metadata = parse(agent.split('---')[1]);
    assert.deepEqual(metadata.tools, []);
    assert.equal(plan.cliOptions.args[plan.cliOptions.args.indexOf('--model') + 1], f.profile.model);
    const settings = JSON.parse(
      readFileSync(plan.cliOptions.args[plan.cliOptions.args.indexOf('--settings') + 1], 'utf8'),
    );
    assert.equal(settings.allowNonWorkspaceAccess, false);
    assert.deepEqual(readdirSync(join(gemini, 'config/skills')), []);
    const hook = JSON.parse(readFileSync(join(gemini, 'config/hooks.json'), 'utf8'));
    assert.match(JSON.stringify(hook), /plugin-native/);
    assert.match(JSON.stringify(hook), /plugin__dev\.clowder\.fixture__player/);
    assert.equal(readFileSync(f.settingsPath, 'utf8'), f.originalSettings);
  } finally {
    await plan.disposeCredentials?.();
  }
});

test('AGY member identity uses the scoped projection before preparing credentials', async (t) => {
  const f = fixture(t);
  let compiled: unknown;
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    profile: f.profile,
    command: '/usr/bin/true',
    l0CompilerFn: async (input) => {
      compiled = input;
      throw new Error('fixture compilation stop');
    },
  });
  for await (const _event of service.invoke('Observe.', f.options)) {
    /* no provider can launch */
  }
  assert.equal((compiled as { projection?: string })?.projection, 'scoped-member');
  assert.equal((compiled as { runtimeModel?: string })?.runtimeModel, f.profile.model);
});

test('AGY member currentness is checked before compiling the identity', async (t) => {
  const f = fixture(t);
  let compiled = 0,
    checked = 0;
  assert.ok(f.options.pluginNativeLaunch);
  f.options.pluginNativeLaunch = {
    ...f.options.pluginNativeLaunch,
    assertCurrent: () => {
      checked++;
      throw new Error('revoked member');
    },
  };
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    profile: f.profile,
    l0CompilerFn: async () => {
      compiled++;
      return '# Identity';
    },
  });
  for await (const _event of service.invoke('Observe.', f.options)) {
    /* expected refusal */
  }
  assert.equal(checked, 1);
  assert.equal(compiled, 0);
});

test('native member guard permits only the issued MCP server, including read and resource tools', () => {
  const options = { pluginServerName: 'plugin__dev.clowder.fixture__player', workspaceRoot: '/tmp/game' };
  const call = (name: string, args: Record<string, unknown>) =>
    decideAgyNativeHookPayload(
      {
        workspacePaths: ['/tmp/game'],
        toolCall: { name, args },
      },
      options,
    );
  assert.equal(
    call('call_mcp_tool', { ServerName: options.pluginServerName, ToolName: 'observe', Arguments: {} }).decision,
    'allow',
  );
  for (const [name, args] of [
    ['call_mcp_tool', { ServerName: 'cat-cafe-collab', ToolName: 'post_message' }],
    ['call_mcp_tool', { ServerName: `${options.pluginServerName} `, ToolName: 'observe' }],
    ['view_file', { AbsolutePath: '/tmp/hidden-world.json' }],
    ['list_dir', { DirectoryPath: '/tmp' }],
    ['run_command', { CommandLine: 'cat /tmp/hidden-world.json' }],
    ['read_resource', { ServerName: options.pluginServerName, Uri: 'world://global' }],
    ['invoke_subagent', {}],
    ['send_message', {}],
    ['search_web', {}],
  ] as const)
    assert.equal(call(name, args).decision, 'deny', name);
});
