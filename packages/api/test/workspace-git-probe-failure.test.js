import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const { workspaceGitRoutes } = await import('../dist/routes/workspace-git.js');
const { workspaceRoutes } = await import('../dist/routes/workspace.js');
const { registerWorktrees } = await import('../dist/domains/workspace/workspace-security.js');

describe('workspace git probe failures', () => {
  let app;
  let root;

  beforeEach(async () => {
    app = Fastify();
    await app.register(workspaceGitRoutes);
    await app.register(workspaceRoutes);
    await app.ready();
    root = mkdtempSync(join(tmpdir(), 'workspace-git-probe-'));
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  function initRepo(path) {
    execFileSync('git', ['init'], { cwd: path, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: path });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: path });
    writeFileSync(join(path, 'README.md'), '# test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: path });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: path, stdio: 'ignore' });
  }

  test('real repo stays a normal 200 response', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    initRepo(repo);
    registerWorktrees([{ id: 'probe-real', root: repo, branch: 'main', head: 'abc123' }]);

    const status = await app.inject({ method: 'GET', url: '/api/workspace/git-status?worktreeId=probe-real' });
    assert.equal(status.statusCode, 200);
    assert.equal(JSON.parse(status.payload).isGitRepository, undefined);
  });

  test('plain directory returns the explicit non-git empty state', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    registerWorktrees([{ id: 'probe-plain', root: plain, branch: 'main', head: 'abc123' }]);

    const status = await app.inject({ method: 'GET', url: '/api/workspace/git-status?worktreeId=probe-plain' });
    assert.equal(status.statusCode, 200);
    assert.equal(JSON.parse(status.payload).isGitRepository, false);
    const diff = await app.inject({ method: 'GET', url: '/api/workspace/diff?worktreeId=probe-plain' });
    assert.equal(diff.statusCode, 200);
    assert.equal(JSON.parse(diff.payload).isGitRepository, false);
  });

  test('linked worktree .git file stays a normal repo', async () => {
    const repo = join(root, 'repo-linked');
    mkdirSync(repo);
    initRepo(repo);
    const linked = join(root, 'linked-worktree');
    execFileSync('git', ['worktree', 'add', linked, '-b', 'linked'], { cwd: repo, stdio: 'ignore' });
    registerWorktrees([{ id: 'probe-linked', root: linked, branch: 'linked', head: 'abc123' }]);

    const status = await app.inject({ method: 'GET', url: '/api/workspace/git-status?worktreeId=probe-linked' });
    assert.equal(status.statusCode, 200);
    assert.equal(JSON.parse(status.payload).isGitRepository, undefined);
  });

  test('subdirectory of a parent repo stays a normal repo', async () => {
    const repo = join(root, 'repo-parent');
    mkdirSync(repo);
    initRepo(repo);
    const nested = join(repo, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    registerWorktrees([{ id: 'probe-nested', root: nested, branch: 'main', head: 'abc123' }]);

    const status = await app.inject({ method: 'GET', url: '/api/workspace/git-status?worktreeId=probe-nested' });
    assert.equal(status.statusCode, 200);
    assert.equal(JSON.parse(status.payload).isGitRepository, undefined);
  });

  test('missing git executable is a probe failure, not a non-git empty state', async () => {
    const repo = join(root, 'repo-missing-git');
    mkdirSync(repo);
    initRepo(repo);
    registerWorktrees([{ id: 'probe-missing-git', root: repo, branch: 'main', head: 'abc123' }]);
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      for (const endpoint of ['git-status', 'git-log', 'git-health']) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/workspace/${endpoint}?worktreeId=probe-missing-git`,
        });
        assert.equal(response.statusCode, 503, endpoint);
        assert.equal(JSON.parse(response.payload).code, 'git_unavailable', endpoint);
      }
      const diff = await app.inject({
        method: 'GET',
        url: '/api/workspace/diff?worktreeId=probe-missing-git',
      });
      assert.equal(diff.statusCode, 503);
      assert.equal(JSON.parse(diff.payload).code, 'git_unavailable');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('corrupt git metadata is a probe failure, not a non-git empty state', async () => {
    const corrupt = join(root, 'corrupt');
    mkdirSync(join(corrupt, '.git'), { recursive: true });
    registerWorktrees([{ id: 'probe-corrupt', root: corrupt, branch: 'main', head: 'abc123' }]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/git-status?worktreeId=probe-corrupt',
    });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.payload).code, 'git_unavailable');
  });

  test('ordinary config with empty objects/refs stays non-git', async () => {
    const plain = join(root, 'plain-config');
    mkdirSync(join(plain, 'objects'), { recursive: true });
    mkdirSync(join(plain, 'refs'), { recursive: true });
    writeFileSync(join(plain, 'config'), '[core]\n\tbare = false\n');
    registerWorktrees([{ id: 'probe-plain-config', root: plain, branch: 'main', head: 'abc123' }]);

    for (const endpoint of ['git-status', 'git-log', 'git-health']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/workspace/${endpoint}?worktreeId=probe-plain-config`,
      });
      assert.equal(response.statusCode, 200, endpoint);
      assert.equal(JSON.parse(response.payload).isGitRepository, false, endpoint);
    }
    const diff = await app.inject({
      method: 'GET',
      url: '/api/workspace/diff?worktreeId=probe-plain-config',
    });
    assert.equal(diff.statusCode, 200);
    assert.equal(JSON.parse(diff.payload).isGitRepository, false);
  });

  test('bare repository remains readable for git log but rejects worktree-only endpoints', async () => {
    const repo = join(root, 'repo-for-bare');
    mkdirSync(repo);
    initRepo(repo);
    const bare = join(root, 'bare.git');
    execFileSync('git', ['clone', '--bare', repo, bare], { stdio: 'ignore' });
    registerWorktrees([{ id: 'probe-bare', root: bare, branch: 'main', head: 'abc123' }]);

    const log = await app.inject({ method: 'GET', url: '/api/workspace/git-log?worktreeId=probe-bare' });
    assert.equal(log.statusCode, 200);
    assert.equal(JSON.parse(log.payload).commits.length, 1);
    for (const endpoint of ['git-status', 'git-health']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/workspace/${endpoint}?worktreeId=probe-bare`,
      });
      assert.equal(response.statusCode, 409, endpoint);
      assert.equal(JSON.parse(response.payload).code, 'git_worktree_required', endpoint);
    }
    const diff = await app.inject({ method: 'GET', url: '/api/workspace/diff?worktreeId=probe-bare' });
    assert.equal(diff.statusCode, 409);
    assert.equal(JSON.parse(diff.payload).code, 'git_worktree_required');
  });

  test('damaged bare repository with config evidence is an error', async () => {
    const repo = join(root, 'repo-for-damaged-bare');
    mkdirSync(repo);
    initRepo(repo);
    const bare = join(root, 'damaged-bare.git');
    execFileSync('git', ['clone', '--bare', repo, bare], { stdio: 'ignore' });
    rmSync(join(bare, 'HEAD'));
    rmSync(join(bare, 'objects'), { recursive: true, force: true });
    registerWorktrees([{ id: 'probe-damaged-bare', root: bare, branch: 'main', head: 'abc123' }]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/git-status?worktreeId=probe-damaged-bare',
    });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.payload).code, 'git_unavailable');
  });

  test('bare repository without HEAD/config but with storage is an error', async () => {
    const repo = join(root, 'repo-for-bare-storage');
    mkdirSync(repo);
    initRepo(repo);
    const bare = join(root, 'bare-storage.git');
    execFileSync('git', ['clone', '--bare', repo, bare], { stdio: 'ignore' });
    rmSync(join(bare, 'HEAD'));
    rmSync(join(bare, 'config'));
    registerWorktrees([{ id: 'probe-bare-storage', root: bare, branch: 'main', head: 'abc123' }]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/git-status?worktreeId=probe-bare-storage',
    });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.payload).code, 'git_unavailable');
  });

  test('dangling .git symlink stays an error, while tolerant discovery stays a null result', async (t) => {
    const repo = join(root, 'repo-for-dangling');
    mkdirSync(repo);
    initRepo(repo);
    const realGit = join(repo, 'real-git-dir');
    renameSync(join(repo, '.git'), realGit);
    try {
      symlinkSync(realGit, join(repo, '.git'), 'junction');
    } catch {
      t.skip('cannot create directory junction on this host');
      return;
    }
    renameSync(realGit, join(repo, 'real-git-dir-moved'));
    registerWorktrees([{ id: 'probe-dangling', root: repo, branch: 'main', head: 'abc123' }]);

    const status = await app.inject({
      method: 'GET',
      url: '/api/workspace/git-status?worktreeId=probe-dangling',
    });
    assert.equal(status.statusCode, 503);
    assert.equal(JSON.parse(status.payload).code, 'git_unavailable');

    const discovery = await app.inject({
      method: 'GET',
      url: `/api/workspace/worktrees?repoRoot=${encodeURIComponent(repo)}`,
    });
    assert.equal(discovery.statusCode, 200);
  });
});
