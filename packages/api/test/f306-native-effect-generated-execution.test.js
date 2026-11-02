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
import { assertGuardedOrUnproved } from './helpers/native-effect-policy-assertions.js';
import { nativeHookPrograms } from './helpers/native-hook-programs.js';

// Review sources: 0001790999471381-001503-f363ba0a; 0001791003189297-001590-1599bd12; github:pr-comment:4171745504.
// These programs are inert classifier inputs. Only the fixed printf oracle executes.
const main = '/tmp/f306-policy/projects/relay-station/cat-cafe';
const runtime = '/tmp/f306-policy/projects/relay-station/cat-cafe-runtime';
const payload = (command, cwd, tool_name = 'Bash') => ({
  tool_name,
  cwd,
  tool_input: { command, cmd: command },
  ...(tool_name === 'exec_command' ? { tool_use_id: 'inert-generated-execution' } : {}),
});
const facet = {
  installation: { projectRoot: main, deploymentId: 'runtime' },
  runtime: { worktree: main, apiPid: 4242, apiPort: 18080 },
  hostDependencies: [{ kind: 'api', pid: 4242, port: 18080 }],
};
const bindingCases = [
  ...['eval "$V"', 'eval $V', 'bash -c "$V"', 'sh -c "$V"', '$V', 'W=$V; eval "$W"', 'source "$V"'].map(
    (use) => `V=$(printf 'redis-cli -p 6399 flushall'); ${use}`,
  ),
  'V=`printf "redis-cli -p 6399 flushall"`; eval "$V"',
  'export V=$(printf "redis-cli -p 6399 flushall"); eval "$V"',
  'V=$(printf "redis-cli -p 6399 flushall")\neval "$V"',
  'V=\\\n$(printf "redis-cli -p 6399 flushall"); bash -c "$V"',
  `V=$(echo 'rm -rf ${runtime}'); eval "$V"`,
  'V=$(echo \'git push --force origin main\'); eval "$V"',
  'V=$(printf \'redis-cli -p 6399 flushall\') || eval "$V"',
];
const generatedCases = [
  '$(echo rm) -rf docs',
  '$(echo touch) x',
  '$(printf mv) a b',
  '$(echo redis-cli) -p 6399 flushall',
  '$(echo pnpm) runtime:stop',
  '( $(echo rm) -rf docs )',
  '{ $(echo rm) -rf docs; }',
  '$(echo git) reset --hard',
  '$(echo git) push --force origin main',
  'git $(echo push) --force origin main',
  'git push $(echo --force) origin main',
  '$(echo kill) -9 4242',
  '$(echo pkill) -f node',
  '$(echo hi; redis-cli -p 6399 flushall)',
  '$(pwd)/scripts/run.sh --force',
];
const eofCases = ['git push --force origin main', 'git push -f origin feature:main', 'git push origin :main'];
const guardOrUnproved = (command, cwd) => {
  for (const provider of ['Bash', 'exec_command'])
    assertGuardedOrUnproved(
      decideNativeHookPayload(payload(command, cwd, provider), { selfHost: () => ({ confidence: 'none' }) }),
      `${provider}: ${command}`,
    );
};

test('generated binding provenance survives code consumers and aliases', () => {
  for (const command of bindingCases) guardOrUnproved(command, main);
});
test('all modeled binding producers retain generated evidence, including loop values', () => {
  for (const command of [
    `for V in "$(printf 'redis-cli -p 6399 flushall')"; do eval "$V"; done`,
    `for V in $(printf 'redis-cli -p 6399 flushall'); do bash -c "$V"; done`,
    'for V in `printf "redis-cli -p 6399 flushall"`; do eval "$V"; done',
    `V=$(printf 'redis-cli -p 6399 flushall'); for W in "$V"; do eval "$W"; done`,
    `V=$(printf 'redis-cli -p 6399 flushall'); V=$V; eval "$V"`,
    `V=$(printf 'redis-cli -p 6399 flushall'); for V in; do echo ok; done; eval "$V"`,
    `for V in "$(printf 'git push --force origin main')"; do eval "$V"; done`,
    `for V in "$(printf 'rm -rf ${runtime}')"; do eval "$V"; done`,
  ])
    guardOrUnproved(command, main);
  const branches = Array.from({ length: 7 }, (_, i) => `opaque_status && X${i}=a || X${i}=b;`).join(' ');
  guardOrUnproved(`V=$(printf 'redis-cli -p 6399 flushall'); ${branches} eval "$V"`, main);
});
test('loop data and definite literal overwrites do not inherit stale binding evidence', () => {
  for (const command of [
    `for V in "$(printf 'redis-cli -p 6399 flushall')"; do echo "$V"; done`,
    `V=$(printf 'redis-cli -p 6399 flushall'); for V in 'printf ok'; do eval "$V"; done`,
  ])
    assert.equal(
      decideNativeHookPayload(payload(command, main), { selfHost: () => ({ confidence: 'none' }) }).decision,
      'allow',
      command,
    );
});
test('a generated executable or critical argv never earns a protected read exemption', () => {
  for (const command of generatedCases) guardOrUnproved(command, runtime);
  for (const command of [
    '$(echo git) reset --hard',
    'git $(echo push) --force origin main',
    'git push $(echo --force) origin main',
    `$(echo rm) -rf ${runtime}`,
    '$(echo redis-cli) -p 6399 flushall',
  ])
    guardOrUnproved(command, main);
});
test('an incomplete EOF preserves the known executable prefix in all consumers', () => {
  for (const suffix of [' \\', ' \\\n', " '\n", ' "\n']) {
    for (const command of eofCases) guardOrUnproved(command + suffix, main);
    for (const command of ['kill -9 4242', 'pnpm runtime:stop', "bash -c 'kill -9 4242'"])
      assert.notEqual(assessSideEffect(command + suffix, '/tmp', facet).verdict, 'allow', command + suffix);
    for (const command of ['pnpm gate', "bash -c 'pnpm gate'", "eval 'pnpm gate'"])
      assert.equal(gateBackgroundDecision(payload(command + suffix, main)), true, command + suffix);
  }
});
test('unproved substitution heredocs cannot hide host stops or a gate', () => {
  for (const command of [
    "x=$(cat <<'EOF'\nit's ) here\nEOF\n)\nkill -9 4242",
    "echo $(cat <<'EOF'\nit's\nEOF\n; kill -9 4242)",
  ])
    assert.equal(executedInvocations(command).complete, false, command);
  assert.equal(executedInvocations("x=$(cat <<'EOF'\nit's ) here\nEOF\n)\npnpm gate\n'").complete, false);
  for (const command of ['$(echo kill) -9 4242', '$(echo pkill) -f node', 'V=$(printf "kill -9 4242"); eval "$V"'])
    assert.equal(executedInvocations(command).complete, false, command);
});
test('unused generated bindings and data consumers keep their data role', () => {
  for (const command of [
    'V=$(printf \'redis-cli -p 6399 flushall\'); echo "$V"',
    "V=$(printf 'redis-cli -p 6399 flushall'); printf '%s' \"$V\"",
    "V=$(printf 'redis-cli -p 6399 flushall'); V='printf ok'; eval \"$V\"",
    "V=$(printf 'redis-cli -p 6399 flushall'); (V='printf ok'); echo \"$V\"",
  ])
    assert.equal(
      decideNativeHookPayload(payload(command, main), { selfHost: () => ({ confidence: 'none' }) }).decision,
      'allow',
      command,
    );
  guardOrUnproved("V=$(printf 'redis-cli -p 6399 flushall'); (V='printf ok'); eval \"$V\"", main);
});
test('real provider hook programs refuse generated execution and EOF specimens', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'f306-generated-hook-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  for (const [program, script, tool] of nativeHookPrograms())
    for (const command of [
      bindingCases[0],
      bindingCases[5],
      bindingCases[8],
      `for V in "$(printf 'redis-cli -p 6399 flushall')"; do eval "$V"; done`,
      '$(echo redis-cli) -p 6399 flushall',
      'git push --force origin main \\',
    ]) {
      const result = spawnSync(program, [script], {
        input: JSON.stringify(payload(command, main, tool)),
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: home },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout || '{}').hookSpecificOutput?.permissionDecision, 'deny', command);
    }
});
for (const shell of ['/bin/bash', '/bin/zsh'])
  test(`printf-only EOF oracle with ${shell}`, { skip: !existsSync(shell) }, () => {
    for (const suffix of [' \\', ' \\\n']) {
      const command = `printf '%s' EOF_MARK${suffix}`;
      const actual = spawnSync(shell, shell.endsWith('/zsh') ? ['-f', '-c', command] : ['-c', command], {
        encoding: 'utf8',
        timeout: 2_000,
        env: { PATH: '/usr/bin:/bin' },
      });
      assert.match(actual.stdout, /EOF_MARK/, `${shell}: ${command}`);
      assert.ok(
        executedInvocations(command)
          .pipelines.flat()
          .some(({ name }) => name === 'printf'),
        command,
      );
    }
  });

const realMain = '/tmp/f306-policy/projects/relay-station/cat-cafe';
const generatedOperandReads = [
  'git log --oneline -5 $(git rev-parse HEAD)',
  'git diff $(git merge-base HEAD origin/main) -- docs',
  'git show $(git rev-parse HEAD):docs/ROADMAP.md | head',
  'git status --short $(git rev-parse --show-toplevel)/docs',
  'ls $(git rev-parse --show-toplevel)/docs',
  'rg -n "$(echo pattern)" docs',
  'grep -rn $(basename $PWD) docs',
  'cd $(mktemp -d) && git init',
  'gh pr view $(git branch --show-current) --json state',
  'pnpm --filter @cat-cafe/api test $(git diff --name-only | head -1)',
  'node scripts/x.mjs $(git rev-parse HEAD)',
  `bash -c 'echo "$(date)"'`,
  'docker ps $(echo -a)',
  'RT=$(pwd); ls $RT',
  'B=$(git branch --show-current)\ngit log -1 $B',
];
test('generated positional operands follow ordinary policy in the real shared checkout', () => {
  for (const command of generatedOperandReads)
    for (const provider of ['Bash', 'exec_command'])
      assert.equal(
        decideNativeHookPayload(payload(command, realMain, provider), { selfHost: () => ({ confidence: 'none' }) })
          .decision,
        'allow',
        `${provider}: ${command}`,
      );
});
test('generated program, git subcommand, selectors and mutation flags remain unproved in main', () => {
  for (const command of [
    '$(echo git) reset --hard',
    'git $(echo reset) --hard',
    'git reset $(echo --hard)',
    'git -C $(pwd) reset --hard',
    'git -c $(echo core.pager=x) log',
    'git push $(echo --force) origin main',
    '$(pwd)/scripts/run.sh --force',
  ])
    guardOrUnproved(command, realMain);
});
test('binding target attribution spans generated words without certifying their value', () => {
  for (const command of [
    'V=$(echo redis-cli); $V -p 6399 flushall',
    'V=$(echo 6399); redis-cli -p $V flushall',
    'V=$(echo redis-cli); P=$(echo 6399); $V -p $P flushall',
    'for V in $(echo redis-cli); do $V -p 6399 flushall; done',
  ])
    guardOrUnproved(command, main);
  assert.equal(
    decideNativeHookPayload(payload('V=$(echo redis-cli); echo "$V" -p 6399 flushall', main), {
      selfHost: () => ({ confidence: 'none' }),
    }).decision,
    'allow',
  );
});

test('actual provider hook entries preserve ordinary generated operands in main', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'f306-read-hook-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  for (const [program, script, tool] of nativeHookPrograms())
    for (const command of generatedOperandReads) {
      const actual = spawnSync(program, [script], {
        input: JSON.stringify(payload(command, realMain, tool)),
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: home },
      });
      assert.equal(actual.status, 0, actual.stderr);
      assert.notEqual(JSON.parse(actual.stdout || '{}').hookSpecificOutput?.permissionDecision, 'deny', command);
    }
});

test('incomplete substitution heredocs cannot grant an unknown protected-branch operation', () => {
  for (const suffix of ['', '\\', '\\\n', "'", '"'])
    guardOrUnproved(`echo "$(x=$(cat <<'EOF'\na )\nb\nEOF\n)\ngit push --force origin main ${suffix})"`, '/tmp');
});
