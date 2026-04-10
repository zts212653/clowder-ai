import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..', '..');

export const installScript = resolve(repoRoot, 'scripts', 'install.sh');

export {
  assert,
  basename,
  existsSync,
  join,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  spawnSync,
  symlinkSync,
  tmpdir,
  writeFileSync,
};

export function runSourceOnlySnippet(snippet) {
  const result = spawnSync(
    'bash',
    ['-lc', `set -e\nsource "${installScript}" --source-only >/dev/null 2>&1\n${snippet}`],
    { encoding: 'utf8' },
  );

  assert.equal(
    result.status,
    0,
    [`exit=${result.status}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`].join('\n'),
  );

  return result.stdout.trim();
}

export function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    [`git ${args.join(' ')}`, `exit=${result.status}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`].join(
      '\n',
    ),
  );
  return result;
}

export function initGitRepo(repoRoot, readmeContent = 'seed\n') {
  writeFileSync(join(repoRoot, 'README.md'), readmeContent, 'utf8');
  runGit(['init', '-b', 'main'], repoRoot);
  runGit(['config', 'user.email', 'test@example.com'], repoRoot);
  runGit(['config', 'user.name', 'Test User'], repoRoot);
  runGit(['add', 'README.md'], repoRoot);
  runGit(['commit', '-m', 'init'], repoRoot);
}

export function addWorktree(repoRoot, worktreeRoot, branchName) {
  return runGit(['worktree', 'add', worktreeRoot, '-b', branchName], repoRoot);
}
