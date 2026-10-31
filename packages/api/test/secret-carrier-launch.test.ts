import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'smol-toml';
import { buildCodexNativeEffectGuardArgs } from '../src/domains/cats/services/agents/providers/CodexNativeEffectGuard.js';
import { prepareClaudeSdkLaunch } from '../src/domains/cats/services/agents/providers/claude-sdk-launch.js';

test('Codex native launch installs both content pre-checks and exposure post checks', () => {
  const config = buildCodexNativeEffectGuardArgs().find((arg) => arg.startsWith('hooks=')) ?? '';
  assert.match(config, /secret-native-hook\.mjs/);
  assert.match(config, /PostToolUse/);
  assert.match(config, /PreToolUse/);
});

test('Claude SDK managed settings keep native content hooks for external cwd', async () => {
  const launch = await prepareClaudeSdkLaunch({
    catId: 'opus55',
    model: 'fixture',
    prompt: 'hello',
    l0CompilerFn: async () => 'fixture instructions',
    abortController: new AbortController(),
    options: { workingDirectory: '/tmp' },
  });
  const settings = String(launch.sdkOptions.settings);
  assert.match(settings, /secret-native-hook\.mjs/);
  assert.match(settings, /PostToolUse/);
});

test('Codex secret hooks run for native shell, never for an MCP tool', () => {
  const args = buildCodexNativeEffectGuardArgs();
  const expression = args.find((arg) => arg.startsWith('hooks='));
  assert.ok(expression);
  const config = parse(expression).hooks as Record<
    string,
    Array<{ matcher: string; hooks: Array<{ command: string }> }>
  >;
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const group = config[event].find((group) =>
      group.hooks.some((hook) => hook.command.includes('secret-native-hook.mjs')),
    );
    assert.ok(group);
    assert.ok(new RegExp(group.matcher).test('Bash'));
    assert.equal(new RegExp(group.matcher).test('mcp__cat-cafe-memory__cat_cafe_read_file_slice'), false);
    assert.equal(new RegExp(group.matcher).test('mcp__browser__type'), false);
  }
});
