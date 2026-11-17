import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyManagedGhCohort, isolateManagedGhProgramFixture } from './helpers/managed-gh-cohort.js';
import { nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';

isolateManagedGhProgramFixture();
const source = fileURLToPath(new URL('../../../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-gh-query-cli-')));
const cwd = join(root, 'ordinary');
const runtime = join(root, 'cat-cafe-runtime');
mkdirSync(cwd);
const wrapper = copyManagedGhCohort(runtime);
after(() => rmSync(root, { recursive: true, force: true }));

const cases = [
  ['rerun-help', 'gh run rerun --help | head -65', 'allow'],
  ['rerun-help-boolean', 'gh run rerun --help=1 | cat', 'allow'],
  ['merge-help', "gh pr merge --help | rg -n -C 2 'match-head|squash|delete-branch|admin'", 'allow'],
  ['read-prelude', 'gh auth status; gh run rerun --help | head -65; gh api repos/o/r', 'allow'],
  ['label-list', 'gh label list --search hotfix --json name --limit 50', 'allow'],
  ['label-pipeline', 'gh label list --search hotfix --json name --limit 50 | cat', 'allow'],
  ['managed-help', `${wrapper} pr merge --help | cat`, 'allow'],
  ['managed-rerun-help', `${wrapper} run rerun --help | cat`, 'allow'],
  ['managed-label', `${wrapper} label list --search hotfix --json name --limit 50`, 'allow'],
  ['help-as-value', 'gh pr merge --subject --help --squash 123 | cat', 'deny'],
  ['job-as-value', 'gh run rerun --job --help | cat', 'deny'],
  ['help-disabled', 'gh run rerun --help -h=false | cat', 'deny'],
  ['help-disabled-alias', 'gh run rerun --help=true -h=0 | cat', 'deny'],
  ['help-terminator', 'gh pr merge -- --help | cat', 'deny'],
  ['unmanaged-help', '/opt/unmanaged/gh pr merge --help | cat', 'deny'],
  ['real-rerun', 'gh run rerun 123 --failed | cat', 'deny'],
  ['label-write', 'gh label create bug --color ff0000 | cat', 'deny'],
  ['loader', `NODE_OPTIONS=--import=/tmp/unproved ${wrapper} pr merge --help | cat`, 'deny'],
  ['external-carrier', 'env gh pr merge --help | cat', 'deny'],
  ['namespace', 'source /tmp/unproved; gh pr merge --help | cat', 'deny'],
  ['nested-namespace', 'printf "%s" "$(source /tmp/unproved; gh pr merge --help)" | cat', 'deny'],
  ['target', `gh pr merge --help | cat > ${runtime}/protected-file`, 'deny'],
  ['pipeline-sender', 'gh pr merge --help | /opt/unmanaged/gh pr comment 1 --body unsafe', 'deny'],
];

// Commands are policy inputs only. No gh, SQL, network, signal or payload executes.
test('natural gh queries and controls agree through source, stage, private hook and AGY', () => {
  const entries = [
    ...nativeHookPrograms(source).map(([program, path, tool]) => ({ program, path, tool })),
    {
      program: process.execPath,
      path: join(source, 'packages/mcp-server/dist/runtime/scripts/native-effect-target-guard.mjs'),
      tool: 'exec_command',
    },
    { program: process.execPath, path: join(source, 'scripts/agy-native-effect-guard.mjs'), agy: true },
    {
      program: process.execPath,
      path: join(source, 'packages/mcp-server/dist/runtime/scripts/agy-native-effect-guard.mjs'),
      agy: true,
    },
  ];
  for (const entry of entries) {
    for (const [id, command, expected] of cases) {
      const payload = entry.agy
        ? { toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: cwd } }, workspacePaths: [cwd] }
        : { tool_name: entry.tool, cwd, tool_input: { command, cmd: command } };
      const run = spawnSync(entry.program, [entry.path], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 10000,
        env: nativeHookTestEnv(),
      });
      assert.equal(run.status, 0, `${entry.path} ${id}: ${run.stderr}`);
      const result = run.stdout.trim() ? JSON.parse(run.stdout) : {};
      const decision = entry.agy ? result.decision : (result.hookSpecificOutput?.permissionDecision ?? 'allow');
      assert.equal(decision, expected, `${entry.path} ${id}: ${JSON.stringify(result)}`);
    }
  }
});
