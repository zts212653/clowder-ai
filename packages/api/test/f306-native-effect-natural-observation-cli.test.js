import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyManagedGhCohort, isolateManagedGhProgramFixture } from './helpers/managed-gh-cohort.js';
import { nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';

isolateManagedGhProgramFixture();
const source = fileURLToPath(new URL('../../../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-natural-cli-')));
const runtime = join(root, 'cat-cafe-runtime');
const ordinary = join(root, 'ordinary');
mkdirSync(ordinary);
const main = join(root, 'projects/relay-station/cat-cafe');
mkdirSync(main, { recursive: true });
const wrapper = copyManagedGhCohort(runtime);
after(() => rmSync(root, { recursive: true, force: true }));

const cases = [
  ['clustered-function', `command() { shift; "$@"; }; command -pv rm -rf ${runtime}`, 'deny'],
  ['external-argv', `pnpm exec command -v rm -rf ${runtime}`, 'deny'],
  [
    'input-selected-sender',
    String.raw`printf '%s\n' '/opt/unmanaged/gh pr comment 1 --body unsafe' | xargs command -v`,
    'deny',
  ],
  ['mutated-worktree', 'source /tmp/unproved; command -v git worktree remove --force .', 'deny', main],
  ['mutated-generated-control', 'source /tmp/unproved; command -v "$UNPROVED_PROGRAM" arg1', 'deny', main],
  ['proven-worktree-inquiry', 'command -v git worktree remove --force .', 'allow', main],
  ['proven-signal-inquiry', 'command -v kill -TERM 2147483647', 'allow'],
  ['lookup', 'command -v gh', 'allow'],
  ['lookup-composite', `command -V gh; command -v ${runtime}/scripts/runtime-stop.mjs`, 'allow'],
  [
    'query-only',
    `sqlite3 -readonly ${runtime}/evidence.sqlite "PRAGMA query_only=ON; SELECT name, sql FROM sqlite_master WHERE type='index';"`,
    'allow',
  ],
  ['managed-send', `${wrapper} pr comment 1 --repo o/r --body safe`, 'allow'],
  ['lookup-output', `command -v gh > ${runtime}/output`, 'deny'],
  ['lookup-nested-send', 'command -v $(/opt/unmanaged/gh pr comment 1 --body unsafe)', 'deny'],
  [
    'query-then-write',
    `sqlite3 -readonly ${runtime}/evidence.sqlite "PRAGMA query_only=ON; DELETE FROM example;"`,
    'deny',
  ],
  [
    'path-selector',
    `export PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$PATH; gh pr comment 1 --repo o/r --body safe`,
    'deny',
  ],
  ['inline-loader', `NODE_OPTIONS=--import=/tmp/unproved.mjs ${wrapper} pr comment 1 --repo o/r --body safe`, 'deny'],
  ['function-shadow', `command() { shift; "$@"; }; command -v rm -rf ${runtime}`, 'deny'],
  ['shell-startup', `BASH_ENV=/tmp/unproved-functions bash -c 'command -v rm -rf ${runtime}'`, 'deny'],
  ['function-send', 'command() { shift; "$@"; }; command -v /opt/unmanaged/gh pr comment 1 --body unsafe', 'deny'],
  ['function-substitution', `command() { shift; "$@"; }; printf '%s' "$(command -v rm -rf ${runtime})"`, 'deny'],
];

// All command strings go to guard stdin. No SQL, gh request or production command executes.
test('natural input roles and safety controls agree through source, staged, private hook and AGY CLIs', () => {
  const programs = [
    ...nativeHookPrograms(source).map(([program, path, tool]) => ({ program, path, tool, kind: 'native' })),
    {
      program: process.execPath,
      path: join(source, 'packages/mcp-server/dist/runtime/scripts/native-effect-target-guard.mjs'),
      tool: 'exec_command',
      kind: 'native',
    },
    { program: process.execPath, path: join(source, 'scripts/agy-native-effect-guard.mjs'), kind: 'agy' },
    {
      program: process.execPath,
      path: join(source, 'packages/mcp-server/dist/runtime/scripts/agy-native-effect-guard.mjs'),
      kind: 'agy',
    },
  ];
  for (const entry of programs) {
    for (const [id, command, expected, cwd = ordinary] of cases) {
      const payload =
        entry.kind === 'agy'
          ? {
              toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: cwd } },
              workspacePaths: [cwd],
            }
          : { tool_name: entry.tool, cwd, tool_input: { command, cmd: command } };
      const run = spawnSync(entry.program, [entry.path], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 10000,
        env: nativeHookTestEnv(),
      });
      assert.equal(run.status, 0, `${entry.path} ${id}: ${run.stderr}`);
      const result = run.stdout.trim() ? JSON.parse(run.stdout) : {};
      const decision =
        entry.kind === 'agy' ? result.decision : (result.hookSpecificOutput?.permissionDecision ?? 'allow');
      assert.equal(decision, expected, `${entry.path} ${id}: ${JSON.stringify(result)}`);
    }
  }
});

test('real builtin inquiry of an owned canary does not execute the queried program', () => {
  const bin = join(ordinary, 'bin');
  const canary = join(ordinary, 'executed');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf executed > '${canary}'\n`, { mode: 0o755 });
  const run = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'command -v gh; command -V gh'], {
    cwd: ordinary,
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: ordinary },
    timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(join(bin, 'gh')), run.stdout);
  const check = spawnSync('/bin/test', ['!', '-e', canary]);
  assert.equal(check.status, 0, 'program inquiry executed the canary');
});
