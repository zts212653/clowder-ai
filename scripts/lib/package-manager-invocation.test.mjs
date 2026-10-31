import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { packageManagerInvocation, pnpmInvocation } from './package-manager-invocation.mjs';
import { executedInvocations } from './shell-invocation.mjs';

test('package scripts, child argv and shell strings retain distinct ownership', () => {
  assert.deepEqual(pnpmInvocation(['run', '--if-present', 'gate', 'exec']), {
    kind: 'script',
    complete: true,
    script: 'gate',
  });
  assert.deepEqual(pnpmInvocation(['--filter', 'gate', 'exec', 'printf', '%s', 'pnpm gate']), {
    kind: 'argv',
    complete: true,
    argv: ['printf', '%s', 'pnpm gate'],
  });
  assert.deepEqual(pnpmInvocation(['-c', 'exec', 'pnpm gate']), { kind: 'shell', complete: true, source: 'pnpm gate' });
  assert.equal(pnpmInvocation(['--unknown', 'gate']).complete, false);
  assert.equal(pnpmInvocation(['--filter']).complete, false);
});

test('argv data never becomes a shell while launcher-owned strings do', () => {
  const data = executedInvocations("pnpm exec printf '%s' 'pnpm gate'");
  assert.equal(data.complete, true);
  assert.deepEqual(
    data.pipelines
      .flat()
      .filter((i) => i.name === 'printf')
      .map((i) => i.operands),
    [['%s', 'pnpm gate']],
  );
  assert.equal(data.pipelines.flat().filter((i) => i.name === 'pnpm').length, 1);
  for (const command of ['pnpm exec pnpm gate', "npx -c 'pnpm gate'", "script --command='pnpm gate' /dev/null"])
    assert.ok(
      executedInvocations(command)
        .pipelines.flat()
        .some((i) => i.name === 'pnpm' && i.operands[0] === 'gate'),
      command,
    );
});

test('recursive command dispatch has a bounded failure result', () => {
  assert.equal(executedInvocations(`${'pnpm exec '.repeat(20)}pnpm gate`).complete, false);
});

test('comment-ending backslash never erases the next command, including nested shell contexts', () => {
  for (const command of [
    'echo ok # c\\\npnpm gate',
    '(echo a # c \\\npnpm gate)',
    "bash -c 'echo a # c \\\npnpm gate'",
    "eval 'echo a # c \\\npnpm gate'",
    'echo "$(echo a # c \\\npnpm gate)"',
    'echo `echo a # c \\\npnpm gate`',
  ])
    assert.ok(
      executedInvocations(command)
        .pipelines.flat()
        .some((i) => i.name === 'pnpm' && i.operands[0] === 'gate'),
      command,
    );
});

test('comment continuation rules agree with an effect-free Bash oracle', () => {
  const inner = 'printf ONE # ignored\\\nprintf TWO';
  for (const [command, output, count] of [
    [inner, 'ONETWO', 2],
    [`bash -c '${inner}'`, 'ONETWO', 2],
    [`eval '${inner}'`, 'ONETWO', 2],
  ]) {
    const actual = spawnSync('/bin/bash', ['-c', command], { encoding: 'utf8' });
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(actual.stdout, output);
    assert.equal(
      executedInvocations(command)
        .pipelines.flat()
        .filter((i) => i.name === 'printf').length,
      count,
    );
  }
  assert.equal(
    executedInvocations("printf '%s' 'literal #\\\npnpm gate'")
      .pipelines.flat()
      .some((i) => i.name === 'pnpm'),
    false,
  );
});

test('npm exec exposes child programs without reinterpreting child argv data', () => {
  for (const command of [
    "npm exec -c 'pnpm gate'",
    "npm exec --call='pnpm gate'",
    'npm exec -- pnpm gate',
    'npm --prefix /tmp/package exec -- pnpm gate',
    'npm x --package=pnpm -- pnpm gate',
  ])
    assert.ok(
      executedInvocations(command)
        .pipelines.flat()
        .some((i) => i.name === 'pnpm' && i.operands[0] === 'gate'),
      command,
    );
  const data = executedInvocations("npm exec -- printf '%s' 'pnpm gate'");
  assert.equal(data.complete, true);
  assert.equal(
    data.pipelines.flat().some((i) => i.name === 'pnpm'),
    false,
  );
  assert.deepEqual(data.pipelines.flat().find((i) => i.name === 'printf')?.operands, ['%s', 'pnpm gate']);
  assert.deepEqual(packageManagerInvocation('npm', ['run-script', '--if-present', 'gate', '-c']), {
    kind: 'script',
    complete: true,
    script: 'gate',
  });
  assert.equal(packageManagerInvocation('npm', ['exec', '--package']).complete, false);
  assert.equal(packageManagerInvocation('npm', ['exec', '--unknown']).complete, false);
});

test('env split-string keeps operator punctuation inside argv, not a shell script', () => {
  const execution = executedInvocations('env -S "rm -rf / ; echo data"');
  assert.equal(execution.complete, true);
  assert.ok(execution.pipelines.flat().some((i) => i.name === 'rm' && i.operands.includes('/')));
  assert.equal(
    execution.pipelines.flat().some((i) => i.name === 'echo'),
    false,
  );
});

test('an opaque intermediate program retains its pipeline slot', () => {
  const execution = executedInvocations('lsof -ti tcp:39003 | $FILTER | xargs kill');
  assert.equal(execution.complete, false);
  assert.ok(
    execution.pipelines.some((pipeline) =>
      pipeline.some((item, index) => item.name === undefined && pipeline[index + 1]?.name === 'xargs'),
    ),
  );
});

test('package manager coordinates belong to the child, not its observer', () => {
  for (const command of [
    'npm --prefix /tmp/owned exec -- git reset --hard',
    'pnpm --dir /tmp/owned exec git reset --hard',
  ]) {
    const execution = executedInvocations(command, { cwd: '/tmp/observer' });
    assert.equal(execution.pipelines.flat().find((i) => i.name === 'git')?.cwd, '/tmp/owned', command);
  }
  assert.equal(executedInvocations('npm exec --workspace app -- git reset --hard').complete, false);
  assert.equal(executedInvocations('npm --prefix app exec -- git reset --hard').complete, false);
  assert.equal(
    executedInvocations('npm --prefix app exec -- git reset --hard', { cwd: '/tmp/observer' })
      .pipelines.flat()
      .find((i) => i.name === 'git')?.cwd,
    '/tmp/observer/app',
  );
});

test('npm boolean values distinguish disabled workspace selection from active selection', () => {
  assert.equal(
    packageManagerInvocation('npm', ['exec', '--include-workspace-root=false', '-c', 'pnpm gate']).kind,
    'shell',
  );
  assert.equal(packageManagerInvocation('npm', ['exec', '--workspaces=true', '--', 'pnpm', 'gate']).complete, false);
  assert.equal(packageManagerInvocation('npm', ['exec', '--workspaces=false', '--', 'pnpm', 'gate']).complete, true);
  assert.equal(packageManagerInvocation('npm', ['exec', '--workspaces=unknown', '--', 'pnpm', 'gate']).complete, false);
});
