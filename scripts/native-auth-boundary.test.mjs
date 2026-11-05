import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyShellSegment } from './native-effect-shell-classifier.mjs';
import { decideNativeHookPayload } from './native-effect-target-guard.mjs';
import { secretNativeHook } from './secret-native-hook.mjs';

// Every command below is inert input to policy. Never execute it or launch Codex.
const mutations = [
  'codex login',
  'codex logout',
  'timeout 12 codex login </dev/null 2>&1 | head -30',
  'env CODEX_HOME=/tmp/auth-fixture codex login',
  'HOME=/tmp/auth-fixture codex login --device-auth',
  'CODEX_LOGIN_ATTEMPT=fixture codex logout',
  'codex login &',
  'codex login status; codex login',
  '/opt/tools/codex login',
  '& "C:\\tools\\codex.exe" login',
  String.raw`C:\tools\codex.exe login`,
  String.raw`C:\tools\Codex.EXE logout`,
  String.raw`.\tools\codex.cmd login`,
  String.raw`..\bin\codex.bat logout`,
  String.raw`tools\codex.exe login`,
  String.raw`co\dex.exe login`,
  String.raw`\\server\tools\codex.exe login`,
  String.raw`\tools\codex.exe login`,
  String.raw`env CODEX_HOME=/tmp/fixture C:\tools\codex.exe login`,
  String.raw`powershell.exe -Command C:\tools\codex.exe login`,
  String.raw`cmd.exe /c C:\tools\codex.exe logout`,
  String.raw`cmd.exe /c "C:\Program Files\codex.exe" login`,
  String.raw`powershell.exe -Command '& "C:\Program Files\codex.exe" logout'`,
  String.raw`C:\node\node.exe C:\tools\codex.js login`,
  String.raw`pwsh -Command 'C:\tools\codex.exe login'`,
  'codex.cmd logout',
  'codex -c model="fixture" login',
  'codex --config label="--help" login',
  'codex login --config label="--help"',
  'codex login --experimental_client-id status',
  'codex login --experimental_issuer status',
  'codex --profile fixture login --device-auth',
  'codex --remote status login',
  'codex --remote x logout',
  'codex --remote-auth-token-env MYENV login',
  'codex --remote-auth-token-env MYENV logout',
  'bash -c "codex login"',
  'pwsh -NoProfile -Command "codex login"',
  'powershell.exe -NoProfile -Command "codex logout"',
  'cmd.exe /d /s /c "codex login"',
  'printf "%s" "codex login" | bash',
  'node /opt/node_modules/@openai/codex/bin/codex.js login',
];
const observations = [
  'codex login status',
  'codex login --help',
  'codex login --device-auth --help',
  'codex logout -h',
  'codex help login',
  'codex --help',
  'codex -c model="fixture" login status',
  'env CODEX_HOME=/tmp/auth-fixture codex login status',
  'cmd.exe /c "codex login status"',
  String.raw`C:\tools\codex.exe login status`,
  String.raw`C:\tools\codex.exe login --help`,
  String.raw`cmd.exe /c C:\tools\codex.exe login status`,
  String.raw`tools\codex.exe login status`,
  String.raw`cmd.exe /c "C:\Program Files\codex.exe" login status`,
  String.raw`C:\node\node.exe C:\tools\codex.js login status`,
];
const ordinary = [
  'echo "codex login"',
  'rg "codex logout" docs',
  '# codex login\necho safe',
  "cat <<'EOF'\ncodex login\nEOF",
  "printf '%s' 'codex login' > example.txt",
  'git log --grep="codex login"',
  'custom-tool --new-operation',
  'touch fixture.txt',
  'node -e "console.log(\'codex login\')"',
  String.raw`echo C:\tools\codex.exe login`,
  String.raw`rg C:\tools\codex.exe docs`,
  String.raw`C:\tools\mycodex.exe login`,
  String.raw`C:\tools\codex.exe.log login`,
  String.raw`C:\node\node.exe -e "console.log('codex login')"`,
  String.raw`C:\tools\codex.exe`,
  String.raw`C:\tools\codex.exe exec -- fixture`,
];

const payload = (command, tool_name = 'Bash') => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input: { command },
  cwd: '/tmp/auth-boundary-fixture',
});

for (const command of mutations) {
  test(`actual injected native hook denies authentication mutation: ${command}`, async () => {
    for (const tool of ['Bash', 'exec_command']) {
      const result = await secretNativeHook(payload(command, tool));
      assert.equal(result?.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /native_auth_mutation/);
    }
  });
  test(`shared effect guard denies authentication mutation: ${command}`, () => {
    const result = decideNativeHookPayload(payload(command), { selfHost: () => ({ confidence: 'none' }) });
    assert.equal(result.effect, 'auth_mutation');
    assert.equal(result.decision, 'deny');
    assert.equal(result.reasonCode, 'native_auth_mutation');
  });
}

for (const command of observations) {
  test(`Codex authentication observation remains read-only: ${command}`, async () => {
    assert.equal(await secretNativeHook(payload(command)), null);
    assert.equal(classifyShellSegment(command), 'read');
    assert.equal(decideNativeHookPayload(payload(command)).decision, 'allow');
  });
}
for (const command of ordinary) {
  test(`authentication check leaves ordinary work unchanged: ${command}`, async () => {
    assert.equal(await secretNativeHook(payload(command)), null);
    assert.equal(decideNativeHookPayload(payload(command)).decision, 'allow');
  });
}

test('standalone injected hook rejects before the tool, with actionable account guidance', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./secret-native-hook.mjs', import.meta.url))], {
    input: JSON.stringify(payload(mutations[2])),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /account/i);
});

test('authentication words in a completed result do not run a pre-check', async () => {
  assert.equal(
    await secretNativeHook({ ...payload('codex login'), hook_event_name: 'PostToolUse', tool_response: 'safe' }),
    null,
  );
});

test('ordinary unknown and write classifications keep their existing meaning', () => {
  assert.equal(classifyShellSegment('custom-tool --new-operation'), 'unknown');
  assert.equal(classifyShellSegment('touch fixture.txt'), 'write');
  assert.equal(classifyShellSegment('codex exec -- echo --help'), 'unknown');
});

test('native Windows executor projects its command into authentication policy', () => {
  for (const [command, expected] of [
    [String.raw`C:\tools\codex.exe login`, 'deny'],
    [String.raw`cmd.exe /c "C:\Program Files\codex.exe" logout`, 'deny'],
    [String.raw`C:\tools\codex.exe login status`, 'allow'],
  ]) {
    const result = decideNativeHookPayload(
      {
        session_id: 'fixture-session',
        turn_id: 'fixture-turn',
        tool_use_id: 'fixture-call',
        hook_event_name: 'NativeShellSafetyCheck',
        tool_name: 'Bash',
        cwd: process.cwd(),
        native_execution: {
          plan_id: 'fixture-plan',
          call_id: 'fixture-call',
          turn_id: 'fixture-turn',
          environment_id: 'local',
          cwd_uri: pathToFileURL(process.cwd()).href,
          argv: ['powershell.exe', '-NoProfile', '-Command', command],
          command,
          phase: 'before_first_effect',
          constraints: {},
          fingerprint: 'fixture-fingerprint',
        },
      },
      { selfHost: () => ({ confidence: 'none' }) },
    );
    assert.equal(result.decision, expected);
    if (expected === 'deny') assert.equal(result.reasonCode, 'native_auth_mutation');
    else assert.equal(result.effect, 'read');
  }
});
