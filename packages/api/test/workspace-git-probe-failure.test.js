import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

  test('a committed bare repository keeps its readable commit log', async () => {
    const repo = join(root, 'bare-source');
    const bare = join(root, 'bare.git');
    mkdirSync(repo);
    initRepo(repo);
    execFileSync('git', ['clone', '--bare', repo, bare], { stdio: 'ignore' });
    registerWorktrees([{ id: 'probe-bare', root: bare, branch: '(bare)', head: 'abc123' }]);

    const response = await app.inject({ method: 'GET', url: '/api/workspace/git-log?worktreeId=probe-bare' });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.payload);
    assert.notEqual(body.isGitRepository, false);
    assert.equal(body.commits.length, 1);
    assert.equal(body.commits[0].subject, 'init');

    for (const endpoint of ['git-status', 'git-health']) {
      const worktreeOnly = await app.inject({
        method: 'GET',
        url: `/api/workspace/${endpoint}?worktreeId=probe-bare`,
      });
      assert.equal(worktreeOnly.statusCode, 409, endpoint);
      assert.equal(JSON.parse(worktreeOnly.payload).code, 'git_worktree_required', endpoint);
    }
    const diff = await app.inject({ method: 'GET', url: '/api/workspace/diff?worktreeId=probe-bare' });
    assert.equal(diff.statusCode, 409);
    assert.equal(JSON.parse(diff.payload).code, 'git_worktree_required');
  });

  test('bare core.bare loaded through include stays an error after damage', async () => {
    const bare = join(root, 'bare-include.git');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    writeFileSync(join(bare, 'config'), '[include]\n\tpath = bare-config\n');
    writeFileSync(join(bare, 'bare-config'), '[core]\n\tbare = true\n');
    execFileSync('git', ['config', '--includes', '--file', join(bare, 'config'), '--type=bool', '--get', 'core.bare']);
    rmSync(join(bare, 'HEAD'));
    rmSync(join(bare, 'objects'), { recursive: true, force: true });
    registerWorktrees([{ id: 'probe-bare-include', root: bare, branch: '', head: '' }]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/git-status?worktreeId=probe-bare-include',
    });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.payload).code, 'git_unavailable');
  });

  test('broken global Git configuration stays an error at all four read endpoints', async () => {
    const plain = join(root, 'plain-with-broken-config');
    mkdirSync(plain);
    const config = join(root, 'broken.gitconfig');
    writeFileSync(config, '[bad\n');
    registerWorktrees([{ id: 'probe-broken-config', root: plain, branch: '', head: '' }]);
    const originalConfig = process.env.GIT_CONFIG_GLOBAL;
    const originalCwd = process.cwd();
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      for (const endpoint of ['git-status', 'git-log', 'git-health', 'diff']) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/workspace/${endpoint}?worktreeId=probe-broken-config`,
        });
        assert.equal(response.statusCode, 503, `${endpoint} from API cwd`);
        assert.equal(JSON.parse(response.payload).code, 'git_unavailable', `${endpoint} from API cwd`);
        assert.notEqual(JSON.parse(response.payload).isGitRepository, false, `${endpoint} from API cwd`);
      }

      process.chdir(plain);
      for (const endpoint of ['git-status', 'git-log', 'git-health', 'diff']) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/workspace/${endpoint}?worktreeId=probe-broken-config`,
        });
        assert.equal(response.statusCode, 503, `${endpoint} from plain cwd`);
        assert.equal(JSON.parse(response.payload).code, 'git_unavailable', `${endpoint} from plain cwd`);
        assert.notEqual(JSON.parse(response.payload).isGitRepository, false, `${endpoint} from plain cwd`);
      }
    } finally {
      process.chdir(originalCwd);
      if (originalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = originalConfig;
    }
  });

  test('a registered checkout with a dangling .git link stays an error', async () => {
    const repo = join(root, 'symlink-checkout');
    const metadata = join(root, 'git-metadata');
    mkdirSync(repo);
    initRepo(repo);
    renameSync(join(repo, '.git'), metadata);
    symlinkSync(metadata, join(repo, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    registerWorktrees([{ id: 'probe-symlink', root: repo, branch: 'main', head: 'abc123' }]);
    const valid = await app.inject('/api/workspace/git-status?worktreeId=probe-symlink');
    assert.equal(valid.statusCode, 200);
    assert.notEqual(JSON.parse(valid.payload).isGitRepository, false);

    renameSync(metadata, join(root, 'moved-metadata'));
    for (const endpoint of ['git-status', 'git-log', 'git-health', 'diff']) {
      const response = await app.inject(`/api/workspace/${endpoint}?worktreeId=probe-symlink`);
      assert.equal(response.statusCode, 503, endpoint);
      assert.equal(JSON.parse(response.payload).code, 'git_unavailable', endpoint);
    }
  });

  test('a registered bare repository missing HEAD stays an error', async () => {
    const bare = join(root, 'missing-head.git');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    registerWorktrees([{ id: 'probe-bare-missing-head', root: bare, branch: '(bare)', head: '' }]);
    unlinkSync(join(bare, 'HEAD'));

    for (const endpoint of ['git-status', 'git-log', 'git-health', 'diff']) {
      const response = await app.inject(`/api/workspace/${endpoint}?worktreeId=probe-bare-missing-head`);
      assert.equal(response.statusCode, 503, endpoint);
      assert.equal(JSON.parse(response.payload).code, 'git_unavailable', endpoint);
    }
  });

  test('surviving Git storage still identifies a bare root missing HEAD and config', async () => {
    const bare = join(root, 'missing-head-and-config.git');
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    registerWorktrees([{ id: 'probe-bare-storage', root: bare, branch: '(bare)', head: '' }]);
    unlinkSync(join(bare, 'HEAD'));
    unlinkSync(join(bare, 'config'));

    for (const endpoint of ['git-status', 'git-log', 'git-health', 'diff']) {
      const response = await app.inject(`/api/workspace/${endpoint}?worktreeId=probe-bare-storage`);
      assert.equal(response.statusCode, 503, endpoint);
      assert.equal(JSON.parse(response.payload).code, 'git_unavailable', endpoint);
    }
  });

  test('ordinary folders with partial marker names still get the normal empty state', async () => {
    const plain = join(root, 'ordinary-marker-names');
    mkdirSync(plain);
    mkdirSync(join(plain, 'objects'));
    mkdirSync(join(plain, 'refs'));
    writeFileSync(join(plain, 'config'), '[application]\n bare = true\n');
    registerWorktrees([{ id: 'probe-ordinary-markers', root: plain, branch: '', head: '' }]);

    for (const endpoint of ['git-status', 'git-log', 'git-health', 'diff']) {
      const response = await app.inject(`/api/workspace/${endpoint}?worktreeId=probe-ordinary-markers`);
      assert.equal(response.statusCode, 200, endpoint);
      assert.equal(JSON.parse(response.payload).isGitRepository, false, endpoint);
    }
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
});
