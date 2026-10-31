import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { initRepoIdentity, isSameRepo } from '../../dist/utils/is-same-repo.js';

function configureTestRepo(repoPath) {
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
}

describe('isSameRepo', () => {
  let mainRepo;
  let worktreeDir;

  before(() => {
    const base = mkdtempSync(join(tmpdir(), 'is-same-repo-'));
    mainRepo = join(base, 'main');
    worktreeDir = join(base, 'wt');
    execFileSync('git', ['init', mainRepo]);
    configureTestRepo(mainRepo);
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: mainRepo });
    writeFileSync(join(mainRepo, 'README.md'), '# test');
    execFileSync('git', ['add', '.'], { cwd: mainRepo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: mainRepo });
    execFileSync('git', ['worktree', 'add', worktreeDir, '-b', 'wt-branch'], { cwd: mainRepo });
  });

  after(() => {
    try {
      execFileSync('git', ['worktree', 'remove', worktreeDir, '--force'], { cwd: mainRepo });
    } catch {
      /* ignore */
    }
    const base = join(mainRepo, '..');
    rmSync(base, { recursive: true, force: true });
  });

  it('returns true for identical paths', () => {
    initRepoIdentity(mainRepo);
    assert.equal(isSameRepo(mainRepo, mainRepo), true);
  });

  it('returns true for worktree of the same repo', () => {
    initRepoIdentity(mainRepo);
    assert.equal(isSameRepo(worktreeDir, mainRepo), true);
  });

  it('returns true when repoRoot is the worktree and projectPath is the main repo', () => {
    initRepoIdentity(worktreeDir);
    assert.equal(isSameRepo(mainRepo, worktreeDir), true);
  });

  it('returns false for a different repo', () => {
    const otherBase = mkdtempSync(join(tmpdir(), 'is-same-repo-other-'));
    const otherRepo = join(otherBase, 'other');
    execFileSync('git', ['init', otherRepo]);
    configureTestRepo(otherRepo);
    writeFileSync(join(otherRepo, 'README.md'), '# other');
    execFileSync('git', ['add', '.'], { cwd: otherRepo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: otherRepo });

    initRepoIdentity(mainRepo);
    assert.equal(isSameRepo(otherRepo, mainRepo), false);

    rmSync(otherBase, { recursive: true, force: true });
  });

  it('returns false for a non-git directory', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'is-same-repo-nogit-'));
    initRepoIdentity(mainRepo);
    assert.equal(isSameRepo(nonGit, mainRepo), false);
    rmSync(nonGit, { recursive: true, force: true });
  });
});
