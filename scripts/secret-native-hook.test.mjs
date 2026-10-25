import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

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
