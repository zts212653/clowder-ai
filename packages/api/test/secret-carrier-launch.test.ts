import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardMcpConfig } from '../src/config/capabilities/secret-mcp-config.js';
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

test('MCP wrapping preserves SSE and secret auth as transport configuration', () => {
  const server = guardMcpConfig(
    { type: 'sse', url: 'https://example.invalid/mcp', headers: { Authorization: 'host-injected' }, enabled: true },
    { CAT_CAFE_API_URL: 'http://127.0.0.1:59999' },
  );
  const env = server.env as Record<string, string>;
  const spec = JSON.parse(env.CAT_CAFE_SECRET_MCP_PROXY_SPEC);
  assert.equal(spec.transport, 'sse');
  assert.equal(spec.headers.Authorization, 'host-injected');
  assert.equal(server.url, undefined);
  assert.equal(server.type, undefined);
});

test('a native plugin refreshes invocation auth on an already guarded server without nesting the relay', () => {
  const first = guardMcpConfig({ command: 'fixture', args: ['tool.mjs'] });
  const second = guardMcpConfig(first, {
    CAT_CAFE_API_URL: 'http://127.0.0.1:59999',
    CAT_CAFE_INVOCATION_ID: 'current-inv',
    CAT_CAFE_CALLBACK_TOKEN: 'fixture-current',
  });
  assert.deepEqual(second.args, first.args);
  assert.equal((second.env as Record<string, string>).CAT_CAFE_INVOCATION_ID, 'current-inv');
  const original = JSON.parse((second.env as Record<string, string>).CAT_CAFE_SECRET_MCP_PROXY_SPEC);
  assert.equal(original.command, 'fixture');
  assert.equal(original.env.CAT_CAFE_CALLBACK_TOKEN, undefined, 'a foreign upstream does not inherit host auth');
});
