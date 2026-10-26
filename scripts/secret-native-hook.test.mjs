import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { PENDING_EXPOSURE_NOTICE } from './lib/secret-tool-io.mjs';
import { secretNativeHook } from './secret-native-hook.mjs';

const hook = resolve('scripts/secret-native-hook.mjs');
const secret = () => ['ghp', '_', 'H'.repeat(36)].join('');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CAT_CAFE_')));
function invoke(payload) {
  return spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), env, encoding: 'utf8' });
}
test('actual hook blocks native reads, search and MCP args, with no secret diagnostics', () => {
  for (const [tool_name, tool_input] of [
    ['Read', { file_path: '/project/.env.local' }],
    ['Bash', { command: 'set -- .env.local; cat "$1"' }],
    ['exec_command', { cmd: 'set -- .env.local; cat "$@"' }],
    ['mcp__browser__type', { text: secret() }],
  ]) {
    const result = invoke({ hook_event_name: 'PreToolUse', tool_name, tool_input });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret()));
  }
  assert.equal(
    invoke({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/project/README.md' } })
      .stdout,
    '',
  );
});
test('an already exposed native result produces a rotation instruction without repeating it', () => {
  const result = invoke({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'test-call',
    tool_response: { stdout: secret() },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /轮转|rotate/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret()));
  assert.equal(invoke({ hook_event_name: 'PostToolUse', tool_response: { stdout: 'safe result' } }).stdout, '');
});

for (const recorded of [true, false]) {
  for (const mcp of [false, true]) {
    test(`${mcp ? 'MCP' : 'native'} post-hook describes exposure truthfully when notice ${recorded ? 'records' : 'fails'}`, async () => {
      const notices = [];
      const original = { content: [{ type: 'text', text: secret() }] };
      const result = await secretNativeHook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: mcp ? 'mcp__fixture__read' : 'Bash',
          tool_use_id: 'exposure-context-test',
          tool_response: original,
        },
        {
          notify: async (notice) => {
            notices.push(notice);
            if (!recorded) throw new Error('fixture notice unavailable');
          },
        },
      );
      const output = result.hookSpecificOutput;
      assert.equal(notices.length, 1);
      assert.equal(notices[0].state, 'exposed_or_suspected');
      assert.equal(notices[0].callId, 'exposure-context-test');
      assert.ok(!JSON.stringify(notices).includes(secret()));
      assert.ok(!JSON.stringify(result).includes(secret()));
      assert.equal(original.content[0].text, secret(), 'the original provider result has not been replaced in place');
      assert.match(output.additionalContext, recorded ? /原线程轮转提醒已持久保存/ : /原线程轮转提醒未能保存/);
      assert.equal(output.additionalContext.includes(PENDING_EXPOSURE_NOTICE), !recorded);
      if (mcp) {
        assert.match(output.additionalContext, /已隐藏/);
        assert.equal(output.updatedMCPToolOutput._meta.secretExposure.rotationNotice, recorded ? 'recorded' : 'failed');
      } else {
        assert.equal(Object.hasOwn(output, 'updatedMCPToolOutput'), false);
        assert.match(output.additionalContext, /原生工具结果.*已进入模型上下文.*无法隐藏.*请轮转/);
        assert.doesNotMatch(output.additionalContext, /已隐藏/);
      }
    });
  }
}
