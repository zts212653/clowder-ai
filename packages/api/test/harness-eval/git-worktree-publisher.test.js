import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

function createRepoWithOrigin() {
  const repoRoot = fs.mkdtempSync(join(tmpdir(), 'publish-wt-repo-'));
  const remoteRoot = fs.mkdtempSync(join(tmpdir(), 'publish-wt-remote-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', remoteRoot], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteRoot], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['fetch', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  return { repoRoot, remoteRoot };
}

function branchExists(repoRoot, branchName) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  syncBuiltinESMExports();
});

describe('createGitWorktreePublisher', () => {
  it('cleans up a partially-created local branch when worktree add fails before stage', async (t) => {
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    writeFileSync(join(worktreePath, 'non-empty.txt'), 'trigger partial failure\n');
    const branchName = 'verdict/auto/eval-task-outcome/partial-fail-cleanup';

    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}`
      );
      const publisher = createGitWorktreePublisher({ repoRoot });

      await assert.rejects(
        publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          stage: async () => {
            throw new Error('stage should not run when worktree add fails');
          },
        }),
      );

      assert.equal(
        branchExists(repoRoot, branchName),
        false,
        'partial worktree-add failure must not leak a local branch',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it('does not delete a branch that already existed before the publish attempt', async (t) => {
    const { repoRoot, remoteRoot } = createRepoWithOrigin();
    const branchName = 'verdict/auto/eval-task-outcome/pre-existing-branch';
    execFileSync('git', ['branch', branchName, 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });

    const worktreePath = fs.mkdtempSync(join(tmpdir(), 'publish-wt-target-'));
    writeFileSync(join(worktreePath, 'non-empty.txt'), 'trigger failure without ownership\n');

    t.mock.method(fs, 'mkdtempSync', () => worktreePath);
    syncBuiltinESMExports();

    try {
      const { createGitWorktreePublisher } = await import(
        `../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js?t=${Date.now()}-keep`
      );
      const publisher = createGitWorktreePublisher({ repoRoot });

      await assert.rejects(
        publisher.publishOnIsolatedWorktree({
          branchName,
          sourceBase: 'origin/main',
          stage: async () => {
            throw new Error('stage should not run when worktree add fails');
          },
        }),
      );

      assert.equal(
        branchExists(repoRoot, branchName),
        true,
        'cleanup must not delete a branch that predates this publish attempt',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
