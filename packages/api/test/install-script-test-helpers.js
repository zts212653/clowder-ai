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

/**
 * Snippets may call install.sh's `run_install_auth_config`, which spawns the
 * standalone installer. That child inherits NODE_TEST_CONTEXT and so is subject
 * to the installer's fail-closed boundary (P1-6), which needs a declared
 * sandbox root. Every fixture in these suites lives under mkdtemp(tmpdir()),
 * and install.sh deliberately writes to two roots per call (project + runtime
 * worktree), so tmpdir() is the smallest root that covers a snippet without
 * enumerating both. Callers with a tighter fixture may pass sandboxRoot.
 */
export function runSourceOnlySnippet(snippet, { sandboxRoot = tmpdir() } = {}) {
  const result = spawnSync(
    'bash',
    ['-lc', `set -e\nsource "${installScript}" --source-only >/dev/null 2>&1\n${snippet}`],
    { encoding: 'utf8', env: { ...process.env, CAT_CAFE_TEST_SANDBOX_ROOT: sandboxRoot } },
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
