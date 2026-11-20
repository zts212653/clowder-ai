import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideAgyNativeHookPayload } from '../../../scripts/agy-native-effect-guard.mjs';
import { AgyNativeAgentService } from '../src/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { prepareAgyNativeLaunch } from '../src/domains/cats/services/agents/providers/agy-native/agy-native-launch.js';
import { watcherPanelToolPolicy } from '../src/domains/concierge/watcher/panel/watcher-panel-policy.js';

test('AGY watcher launch exposes only named MCP readers and keeps native session persistence', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'watcher-agy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = {
    enabled: true,
    autoApprove: true,
    profileId: 'carbon-fixture',
    homeRoot: join(root, 'profiles'),
    model: 'gemini-4-carbon-high',
  };
  const service = new AgyNativeAgentService({ catId: 'gemini-carbon', profile });
  assert.equal(service.supportsToolExecutionPolicy(watcherPanelToolPolicy()), true);
  assert.deepEqual(service.watcherMemberCapability?.(), { supported: true, context: 'ordinary', readOnly: 'tools' });
  const plan = await prepareAgyNativeLaunch({
    catId: 'gemini-carbon',
    model: profile.model,
    profileConfig: profile,
    workspace,
    prompt: 'Read the settled work',
    body: 'WATCHER_IDENTITY',
    command: '/usr/bin/true',
    options: {
      toolExecutionPolicy: watcherPanelToolPolicy(),
      workingDirectory: workspace,
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://127.0.0.1:9',
        CAT_CAFE_CAT_ID: 'gemini-carbon',
        CAT_CAFE_INVOCATION_ID: 'fixture',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture',
      },
      spawnCliOverride: async function* () {},
    },
  });
  try {
    assert.deepEqual(plan.agentTools, ['call_mcp_tool']);
    assert.ok(!plan.cliOptions.args.includes('--dangerously-skip-permissions'));
    const gemini = plan.cliOptions.args.find((arg) => arg.startsWith('--gemini_dir='))!.slice('--gemini_dir='.length);
    const servers = JSON.parse(readFileSync(join(gemini, 'config/mcp_config.json'), 'utf8')).mcpServers;
    assert.deepEqual(Object.keys(servers).sort(), ['cat-cafe-collab', 'cat-cafe-memory']);
    for (const server of Object.values(servers) as Array<{ env: Record<string, string> }>)
      assert.deepEqual(JSON.parse(server.env.CAT_CAFE_ALLOWED_TOOL_NAMES), watcherPanelToolPolicy().allowedToolNames);
    assert.match(plan.binding.agentName, /watcher$/);
    assert.ok(!plan.cliOptions.args.includes('--new-project'));
  } finally {
    await plan.disposeCredentials?.();
  }
});

test('AGY watcher effect guard rejects native writers and unlisted MCP calls', () => {
  const options = { watcherTools: { 'cat-cafe-memory': ['cat_cafe_read_memory'] } };
  const decide = (name: string, args: Record<string, unknown>) =>
    decideAgyNativeHookPayload({ toolCall: { name, args } }, options).decision;
  assert.equal(decide('call_mcp_tool', { ServerName: 'cat-cafe-memory', ToolName: 'cat_cafe_read_memory' }), 'allow');
  assert.equal(decide('call_mcp_tool', { ServerName: 'foreign', ToolName: 'cat_cafe_read_memory' }), 'deny');
  assert.equal(decide('call_mcp_tool', { ServerName: 'cat-cafe-memory', ToolName: 'cat_cafe_post_message' }), 'deny');
  for (const helper of ['manage_task', 'list_resources', 'read_resource']) assert.equal(decide(helper, {}), 'deny');
  assert.equal(decide('run_command', { CommandLine: 'touch forbidden' }), 'deny');
  assert.equal(decide('write_file', { Path: '/tmp/forbidden', Content: 'bad' }), 'deny');
});
