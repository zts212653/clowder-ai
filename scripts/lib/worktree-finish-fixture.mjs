/** Real Git fixtures shared by worktree-finish regressions. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishWorktree } from '../worktree-finish.mjs';
import { createWorktree } from '../worktree-new.mjs';

export const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
export const NOW = Date.now();
export const SOURCE = 'task:work:finish-fixture';
export const idle = () => ({ cwds: [], argv: [] });

export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-finish-')));
  const repo = join(root, 'cat-cafe');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  writeFileSync(join(repo, 'README.md'), 'original\n');
  writeFileSync(join(repo, '.gitignore'), readFileSync(new URL('../../.gitignore', import.meta.url)));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const make = (name = 'cat-cafe-finish', policy = 'merged') => {
    const path = join(root, name);
    createWorktree({
      repo,
      path,
      branch: `test/${name}`,
      owner: 'codex61-sol',
      policy,
      ttlDays: policy === 'ttl' ? 1 : undefined,
      now: NOW,
    });
    return path;
  };
  const finish = (path, overrides = {}) =>
    finishWorktree({
      repo,
      path,
      owner: 'codex61-sol',
      sourceRef: SOURCE,
      now: NOW,
      cwdProbe: idle,
      dataRoot: join(root, 'data'),
      ...overrides,
    });
  return { root, repo, make, finish };
}
