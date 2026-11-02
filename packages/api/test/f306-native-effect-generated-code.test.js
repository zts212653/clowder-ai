import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateBackgroundDecision } from '../../../scripts/gate-background-decision.mjs';
import { assessSideEffect } from '../../../scripts/lib/self-host-guard.mjs';
import { executedInvocations } from '../../../scripts/lib/shell-invocation.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { nativeHookPrograms } from './helpers/native-hook-programs.js';

// Sources: 0001791024769295-000123-52248f95; github:pr-comment:4172796415.
// All threat-shaped text is classifier input, never an executed shell command.
const main = '/tmp/f306-policy/projects/relay-station/cat-cafe';
const payload = (command, tool_name = 'Bash') => ({
  tool_name,
  cwd: main,
  tool_input: { command, cmd: command },
  tool_use_id: 'inert-code-origin',
});
const generatedScripts = [
  `eval "$(printf 'git reset --hard')"`,
  `bash -c "$(printf 'git reset --hard')"`,
  `sh -c "$(printf 'git reset --hard')"`,
  `bash -c "echo $(printf 'OK; git reset --hard')"`,
  `eval echo "$(printf 'OK; git reset --hard')"`,
  'bash -c "echo $(date)"',
  'eval "$(ssh-agent -s)"',
  `timeout 2 bash -xc "echo $(printf 'OK; git reset --hard')"`,
  `env -S "bash -c 'echo $(printf 'OK; git reset --hard')'"`,
  `pnpm exec bash -c "echo $(printf 'OK; git reset --hard')"`,
  `npm exec --call="echo $(printf 'OK; git reset --hard')"`,
  `V=$(printf 'OK; git reset --hard'); bash -c "echo $V"`,
  'bash -c "echo $SCRIPT"',
  `bash -c "echo \${SCRIPT:-fallback}"`,
  `bash -c 'eval "$1"' _ "$(printf 'git reset --hard')"`,
];
const dataScripts = [
  `bash -c 'echo "$(date)"'`,
  `bash -c 'printf "%s" "$1"' _ "$(printf 'OK; git reset --hard')"`,
  `bash -c 'echo "$(printf "%s" "OK; git reset --hard")"'`,
  `echo "$(printf 'OK; git reset --hard')"`,
  `bash -c 'printf "%s" catcafe_substitution' _ "$(date)"`,
];

test('the reader records generated code operands separately from completeness', () => {
  for (const command of generatedScripts)
    assert.ok(
      executedInvocations(command)
        .pipelines.flat()
        .some((call) => call.generatedCode),
      command,
    );
  for (const command of dataScripts)
    assert.ok(
      !executedInvocations(command)
        .pipelines.flat()
        .some((call) => call.generatedCode),
      command,
    );
});
test('whole and partial generated code cannot defer to ordinary policy in shared main', () => {
  for (const command of generatedScripts)
    for (const provider of ['Bash', 'exec_command'])
      assert.equal(
        decideNativeHookPayload(payload(command, provider), { selfHost: () => ({ confidence: 'none' }) }).decision,
        'deny',
        command,
      );
});
test('fixed scripts receive generated data without treating it as new shell syntax', () => {
  for (const command of dataScripts)
    for (const provider of ['Bash', 'exec_command'])
      assert.equal(
        decideNativeHookPayload(payload(command, provider), { selfHost: () => ({ confidence: 'none' }) }).decision,
        'allow',
        command,
      );
});
test('actual provider hook entries consume the same generated-code origin fact', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'f306-code-role-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [program, script, provider] of nativeHookPrograms())
    for (const [commands, expected] of [
      [generatedScripts, true],
      [dataScripts, false],
    ])
      for (const command of commands) {
        const actual = spawnSync(program, [script], {
          input: JSON.stringify(payload(command, provider)),
          encoding: 'utf8',
          timeout: 10_000,
          env: { PATH: process.env.PATH, HOME: home },
        });
        assert.equal(actual.status, 0, actual.stderr);
        assert.equal(
          JSON.parse(actual.stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny',
          expected,
          command,
        );
      }
});
for (const shell of ['/bin/bash', '/bin/zsh'])
  test(`printf-only code/data oracle with ${shell}`, { skip: !existsSync(shell) }, () => {
    const quote = (source) => `'${source.replaceAll("'", "'\\''")}'`;
    const fragment = 'OK; printf SECOND_PARSE_MARK';
    const forms = [
      [`bash -c "echo $(printf '%s' ${quote(fragment)})"`, 'OK\nSECOND_PARSE_MARK'],
      [`bash -c ${quote(`echo "$(printf "%s" "${fragment}")"`)}`, `${fragment}\n`],
      [`bash -c ${quote('printf "%s" "$1"')} _ "$(printf '%s' ${quote(fragment)})"`, fragment],
    ];
    for (const [command, output] of forms) {
      const actual = spawnSync(shell, shell.endsWith('/zsh') ? ['-f', '-c', command] : ['-c', command], {
        encoding: 'utf8',
        timeout: 2_000,
        env: { PATH: '/usr/bin:/bin' },
      });
      assert.equal(actual.status, 0, actual.stderr);
      assert.equal(actual.stdout, output, `${shell}: ${command}`);
    }
  });

test('self-host and gate consume unproved code without erasing literal data roles', () => {
  const facet = {
    installation: { projectRoot: main, deploymentId: 'runtime' },
    runtime: { worktree: main, apiPid: 4242, apiPort: 18080 },
    hostDependencies: [{ kind: 'api', pid: 4242, port: 18080 }],
  };
  assert.equal(executedInvocations(`bash -c "echo $(printf 'OK; kill -9 4242')"`).complete, false);
  assert.equal(executedInvocations(`bash -c "echo $(printf 'OK; pnpm gate')"`).complete, false);
  assert.equal(assessSideEffect(`bash -c 'echo "$(printf "%s" "OK; kill -9 4242")"'`, '/tmp', facet).verdict, 'allow');
  assert.equal(gateBackgroundDecision(payload(`bash -c 'echo "$(printf "%s" "OK; pnpm gate")"'`)), false);
});
