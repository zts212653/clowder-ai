import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateBackgroundDecision } from '../../../scripts/gate-background-decision.mjs';
import { assessSideEffect } from '../../../scripts/lib/self-host-guard.mjs';
import { executedInvocations } from '../../../scripts/lib/shell-invocation.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { gateHookProgram, nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';

// Sources: 0001790992047730-001180-9579c288, 0001790992632671-001208-8b43ecfb.
// Threat specimens are data passed to classifiers/hook stdin, NEVER shell programs.
const cwd = '/home/user/cat-cafe-runtime';
const payload = (command, tool_name = 'Bash') => ({
  tool_name,
  cwd,
  tool_input: { command, cmd: command },
  ...(tool_name === 'exec_command' ? { tool_use_id: 'inert-f306-lexical' } : {}),
});
const threats = [
  'redis-cli -p 6399 flushall',
  'curl -X POST http://localhost:3004/api/threads',
  'pnpm preview:process stop runtime',
];
const prefixes = [
  "echo $(date) # it's\n",
  "echo `date` # don't\n",
  'echo "$(date)" # "it\'s" \\\n',
  "# note: don't\nV=$(git rev-parse HEAD)\n",
  "echo $(printf '# not a comment') # it's\n",
];

test('comment apostrophes never hide known sanctuary mutations in either provider', () => {
  for (const prefix of prefixes) {
    for (const threat of threats) {
      for (const provider of ['Bash', 'exec_command']) {
        const command = prefix + threat;
        const decision = decideNativeHookPayload(payload(command, provider), {
          selfHost: () => ({ confidence: 'none' }),
        });
        assert.equal(decision.source.provider, provider === 'exec_command' ? 'codex' : 'claude');
        assert.equal(decision.decision, 'deny', `${provider}: ${command}`);
      }
    }
  }
});

test('actual Codex and Claude hook programs deny the inert specimens and execute controls', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'f306-lexical-hook-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  for (const [program, script, provider] of nativeHookPrograms()) {
    for (const command of [...threats, ...threats.map((threat) => prefixes[0] + threat), prefixes[1] + threats[0]]) {
      const result = spawnSync(program, [script], {
        input: JSON.stringify(payload(command, provider)),
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: home },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /unavailable|failed/i);
      assert.equal(JSON.parse(result.stdout || '{}').hookSpecificOutput?.permissionDecision, 'deny', command);
    }
  }
});

const facet = {
  installation: { projectRoot: '/home/user/cat-cafe-f300', deploymentId: 'runtime' },
  runtime: { worktree: '/home/user/cat-cafe-f300', apiPid: 4242, apiPort: 18080 },
  hostDependencies: [{ kind: 'api', pid: 4242, port: 18080 }],
};
test('shared reader and self-host retain signals after comments containing quotes and substitutions', () => {
  for (const prefix of prefixes) {
    const command = prefix + 'kill -9 4242';
    assert.ok(
      executedInvocations(command)
        .pipelines.flat()
        .some(({ name }) => name === 'kill'),
      command,
    );
    assert.notEqual(assessSideEffect(command, '/tmp', facet).verdict, 'allow', command);
  }
});

test('dangling quotes report incomplete while already executed gate prefixes remain visible', () => {
  const cases = [
    "echo ok # c \\\nbash -c 'echo hi\npnpm gate' #c\\; eval 'x #\necho y'",
    "echo $(date) # it's\npnpm gate\n'",
    '# don\'t\necho $(printf ok)\npnpm gate\n"',
  ];
  for (const command of cases) {
    assert.equal(executedInvocations(command).complete, false, command);
    assert.equal(gateBackgroundDecision(payload(command)), true, command);
    const decision = decideNativeHookPayload(payload(command), { selfHost: () => ({ confidence: 'none' }) });
    assert.notEqual(decision.effect, 'read', command);
  }
});

test('the actual gate hook denies comment/apostrophe and EOF variants without executing them', () => {
  const [gateProgram, gateScript] = gateHookProgram();
  for (const command of [
    'pnpm gate',
    "# don't\nV=$(printf ok)\npnpm gate",
    "echo $(printf ok) # it's \\\npnpm gate\n'",
    "echo ok # c \\\nbash -c 'echo hi\npnpm gate' #c\\; eval 'x #\necho y'",
  ]) {
    const result = spawnSync(gateProgram, [gateScript], {
      env: nativeHookTestEnv(),
      input: JSON.stringify(payload(command)),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout || '{}').hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('a later incomplete suffix never skips an earlier known protected effect', () => {
  for (const command of [
    "echo $(date) # it's\nredis-cli -p 6399 flushall\n'",
    '# don\'t\nV=$(printf ok)\nredis-cli -p 6399 flushall\n"',
  ]) {
    const decision = decideNativeHookPayload(payload(command), { selfHost: () => ({ confidence: 'none' }) });
    assert.equal(decision.decision, 'deny');
    assert.equal(decision.effect, 'service_mutation');
  }
});

test('literal comments, quoted hash characters and message heredocs keep their data roles', () => {
  for (const command of [
    "echo $(date) # don't run redis-cli -p 6399 flushall",
    "echo '# it\"s redis-cli -p 6399 flushall'",
    'printf "%s\\n" "# don\'t"',
    'echo \\#literal',
    "cat <<'EOF'\n# don't\nredis-cli -p 6399 flushall\nEOF",
  ]) {
    assert.equal(
      decideNativeHookPayload(payload(command), { selfHost: () => ({ confidence: 'none' }) }).decision,
      'allow',
      command,
    );
    assert.equal(gateBackgroundDecision(payload(command)), false, command);
  }
});

test('nested execution keeps its own targets while the outer substitution output is data', () => {
  for (const command of [
    'echo $(printf ok; redis-cli -p 6399 flushall)',
    'echo "$(printf ok; redis-cli -p 6399 flushall)"',
    'echo `printf ok; redis-cli -p 6399 flushall`',
    'cd /tmp; echo "$(printf ok; redis-cli -p 6399 flushall)"',
    'V=$(redis-cli -p 6399 flushall)',
  ])
    assert.equal(
      decideNativeHookPayload(payload(command), { selfHost: () => ({ confidence: 'none' }) }).decision,
      'deny',
      command,
    );
  for (const command of [
    'echo "$(printf "%s" "redis-cli -p 6399 flushall")"',
    'echo "$(cd /tmp && touch lexical-fixture)"',
    "V='$(redis-cli -p 6399 flushall)'; echo ok",
  ])
    assert.equal(
      decideNativeHookPayload(payload(command), { selfHost: () => ({ confidence: 'none' }) }).decision,
      'allow',
      command,
    );
});

test('an unsupported ordinary preview in a child shell defers to ordinary policy', () => {
  for (const cwd of ['/tmp', '/tmp/f306-policy/projects/relay-station/cat-cafe']) {
    for (const tool of ['Bash', 'exec_command']) {
      const decision = decideNativeHookPayload(
        { ...payload('echo $(printf ok; pnpm preview:process stop runtime)', tool), cwd },
        { selfHost: () => ({ confidence: 'none' }) },
      );
      assert.equal(decision.decision, 'allow');
      assert.notEqual(decision.reasonCode, 'read_only');
    }
  }
});

test('real Bash oracle executes only printf; the shared reader sees every executed marker', () => {
  const sources = [
    "# note: don't\nV=$(printf INNER)\nprintf '%s\\n' OUTER",
    "printf '%s\\n' \"$(printf INNER)\" # it's\nprintf '%s\\n' OUTER",
    "printf '%s\\n' `printf INNER` # don't \\\nprintf '%s\\n' OUTER",
    "printf '%s\\n' '# quoted' # it's\nprintf '%s\\n' OUTER\n'",
  ];
  for (const source of sources) {
    const result = spawnSync('/bin/bash', ['-c', source], {
      encoding: 'utf8',
      timeout: 2_000,
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.match(result.stdout, /OUTER\n/, source);
    const read = executedInvocations(source);
    assert.ok(
      read.pipelines.flat().some(({ name, operands }) => name === 'printf' && operands.includes('OUTER')),
      source,
    );
    if (result.status !== 0) assert.equal(read.complete, false, source);
  }
});
