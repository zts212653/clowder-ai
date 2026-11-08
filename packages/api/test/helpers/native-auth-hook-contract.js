import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import { shellWords } from '../../../../scripts/native-effect-shell-tokenizer.mjs';

// Execute only the composed Host hook. The command it checks stays JSON stdin.
export function assertNativeAuthHookContract(settings) {
  const document = JSON.parse(settings);
  assert.equal(document.disableAllHooks, false);
  const hooks = document.hooks.PreToolUse.filter(({ matcher }) => new RegExp(matcher).test('Bash')).flatMap(
    ({ hooks }) => hooks,
  );
  const managed = hooks.filter(({ command }) => command.includes('secret-native-hook.mjs'));
  assert.equal(managed.length, 1, 'the final carrier settings must include the Host pre-hook exactly once');
  const [hook] = managed;
  const [node, script, ...extra] = shellWords(hook.command).map(({ value }) => value);
  assert.equal(node, process.execPath);
  assert.equal(realpathSync(script), realpathSync(secretRuntimeScript('secret-native-hook.mjs')));
  assert.equal(extra.length, 0);
  for (const [command, expected] of [
    ['timeout 12 codex login </dev/null 2>&1 | head -30', 'deny'],
    ['env CODEX_HOME=/tmp/fixture codex login', 'deny'],
    [String.raw`C:\tools\codex.exe login`, 'deny'],
    [String.raw`cmd.exe /c C:\tools\codex.exe logout`, 'deny'],
    [String.raw`cmd.exe /c "C:\Program Files\codex.exe" login`, 'deny'],
    ['codex login status', undefined],
    [String.raw`C:\tools\codex.exe login status`, undefined],
    ['codex login --help', undefined],
    ['echo "codex login"', undefined],
    ['touch fixture.txt', undefined],
  ]) {
    const result = spawnSync(node, [script], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      timeout: 8000,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : undefined;
    assert.equal(output?.permissionDecision, expected, command);
    if (expected === 'deny') assert.match(output.permissionDecisionReason, /native_auth_mutation/);
  }
}
