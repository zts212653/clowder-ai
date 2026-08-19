/**
 * Integration tests for project-aware workspace — F063 B1
 *
 * GET /api/workspace/worktrees?repoRoot=  — list worktrees for a specific repo
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

// Both repos share basename "myproject" to test worktreeId collision
const TEMP_PARENT_A = join(import.meta.dirname, '__b1_parent_a__');
const TEMP_PARENT_B = join(import.meta.dirname, '__b1_parent_b__');
const TEMP_REPO = join(TEMP_PARENT_A, 'myproject');
const TEMP_REPO_2 = join(TEMP_PARENT_B, 'myproject');

describe('project-aware workspace worktrees', () => {
  let app;

  before(async () => {
    // Create a temporary git repo to use as repoRoot
    await mkdir(TEMP_REPO, { recursive: true });
    execFileSync('git', ['init'], { cwd: TEMP_REPO });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: TEMP_REPO });
    await writeFile(join(TEMP_REPO, 'README.md'), '# temp\n');
    await writeFile(join(TEMP_REPO, '100%-done.md'), '# Literal percent\n');
    await writeFile(join(TEMP_REPO, 'foo%20bar.md'), '# Encoded-looking literal\n');
    await writeFile(join(TEMP_REPO, 'foo bar.md'), '# Decoded sibling\n');
    execFileSync('git', ['add', '.'], { cwd: TEMP_REPO });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: TEMP_REPO });

    // Create a second temp repo with different content
    await mkdir(TEMP_REPO_2, { recursive: true });
    execFileSync('git', ['init'], { cwd: TEMP_REPO_2 });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: TEMP_REPO_2 });
    await writeFile(join(TEMP_REPO_2, 'README.md'), '# repo two\n');
    await writeFile(join(TEMP_REPO_2, 'only-in-two.txt'), 'unique\n');
    execFileSync('git', ['add', '.'], { cwd: TEMP_REPO_2 });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: TEMP_REPO_2 });

    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    app = Fastify();
    await app.register(workspaceRoutes);
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await rm(TEMP_PARENT_A, { recursive: true, force: true });
    await rm(TEMP_PARENT_B, { recursive: true, force: true });
  });

  it('returns worktrees for the default repo when no repoRoot is given', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workspace/worktrees' });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.worktrees), 'worktrees should be an array');
    assert.ok(data.worktrees.length > 0, 'should have at least one worktree');
  });

  it('returns worktrees for a different repo when repoRoot is given', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/worktrees?repoRoot=${encodeURIComponent(TEMP_REPO)}`,
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.worktrees), 'worktrees should be an array');
    // The temp repo should have exactly 1 worktree (itself) and no linked roots
    const gitWorktrees = data.worktrees.filter((w) => !w.id.startsWith('linked_'));
    assert.equal(gitWorktrees.length, 1, 'temp repo should have exactly 1 worktree');
    assert.ok(gitWorktrees[0].root.includes('myproject'), 'root should point to temp repo');
    assert.equal(gitWorktrees[0].branch, 'main');
  });

  it('returns 400 for non-existent repoRoot', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/worktrees?repoRoot=/nonexistent/path/xyz',
    });
    assert.equal(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error);
  });

  it('returns 400 for relative repoRoot', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/worktrees?repoRoot=relative/path',
    });
    assert.equal(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error);
  });

  it('can fetch tree for a foreign repo worktree after listing it', async () => {
    // Step 1: list worktrees for the foreign repo
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/worktrees?repoRoot=${encodeURIComponent(TEMP_REPO)}`,
    });
    assert.equal(listRes.statusCode, 200);
    const { worktrees } = JSON.parse(listRes.body);
    const foreignWt = worktrees.find((w) => !w.id.startsWith('linked_'));
    assert.ok(foreignWt, 'should have a foreign worktree');

    // Step 2: fetch tree using that worktreeId — this is the next-hop test
    const treeRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/tree?worktreeId=${encodeURIComponent(foreignWt.id)}`,
    });
    assert.equal(treeRes.statusCode, 200, 'tree endpoint should resolve foreign worktreeId');
    const treeData = JSON.parse(treeRes.body);
    assert.ok(Array.isArray(treeData.tree), 'should return a tree array');
    // Should contain README.md we created in before()
    const readme = treeData.tree.find((n) => n.name === 'README.md');
    assert.ok(readme, 'should find README.md in foreign repo tree');
  });

  it('does not collide when two foreign repos are listed sequentially', async () => {
    // List repo 1
    const res1 = await app.inject({
      method: 'GET',
      url: `/api/workspace/worktrees?repoRoot=${encodeURIComponent(TEMP_REPO)}`,
    });
    const wt1 = JSON.parse(res1.body).worktrees.find((w) => !w.id.startsWith('linked_'));

    // List repo 2
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/workspace/worktrees?repoRoot=${encodeURIComponent(TEMP_REPO_2)}`,
    });
    const wt2 = JSON.parse(res2.body).worktrees.find((w) => !w.id.startsWith('linked_'));

    // IDs should be different (even if basenames are similar)
    assert.notEqual(wt1.id, wt2.id, 'foreign repo worktree IDs should not collide');

    // Reading file from repo 1 should get repo 1 content
    const file1 = await app.inject({
      method: 'GET',
      url: `/api/workspace/file?worktreeId=${encodeURIComponent(wt1.id)}&path=README.md`,
    });
    assert.equal(file1.statusCode, 200);
    assert.ok(JSON.parse(file1.body).content.includes('# temp'), 'repo 1 should have its own content');

    // Reading file from repo 2 should get repo 2 content
    const file2 = await app.inject({
      method: 'GET',
      url: `/api/workspace/file?worktreeId=${encodeURIComponent(wt2.id)}&path=README.md`,
    });
    assert.equal(file2.statusCode, 200);
    assert.ok(JSON.parse(file2.body).content.includes('# repo two'), 'repo 2 should have its own content');

    // File only in repo 2 should not be accessible via repo 1
    const only2 = await app.inject({
      method: 'GET',
      url: `/api/workspace/file?worktreeId=${encodeURIComponent(wt1.id)}&path=only-in-two.txt`,
    });
    assert.equal(only2.statusCode, 404, 'repo 1 should not see files from repo 2');
  });

  it('can fetch file from a foreign repo worktree after listing it', async () => {
    // Step 1: list worktrees
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/worktrees?repoRoot=${encodeURIComponent(TEMP_REPO)}`,
    });
    const { worktrees } = JSON.parse(listRes.body);
    const foreignWt = worktrees.find((w) => !w.id.startsWith('linked_'));

    // Step 2: fetch file content
    const fileRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/file?worktreeId=${encodeURIComponent(foreignWt.id)}&path=README.md`,
    });
    assert.equal(fileRes.statusCode, 200, 'file endpoint should resolve foreign worktreeId');
    const fileData = JSON.parse(fileRes.body);
    assert.ok(fileData.content.includes('# temp'), 'should contain README content');
  });

  it('preserves native percent bytes from absolute document resolution through file reads', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/workspace/worktrees?repoRoot=${encodeURIComponent(TEMP_REPO)}`,
    });
    assert.equal(listRes.statusCode, 200);

    for (const [fileName, expectedContent] of [
      ['100%-done.md', '# Literal percent'],
      ['foo%20bar.md', '# Encoded-looking literal'],
    ]) {
      const resolveRes = await app.inject({
        method: 'POST',
        url: '/api/workspace/resolve-document-link',
        headers: { 'x-cat-cafe-user': 'default-user' },
        payload: { href: join(TEMP_REPO, fileName) },
      });
      assert.equal(resolveRes.statusCode, 200);

      const target = JSON.parse(resolveRes.body);
      const query = new URLSearchParams({ worktreeId: target.worktreeId, path: target.path });
      const fileRes = await app.inject({ method: 'GET', url: `/api/workspace/file?${query}` });
      assert.equal(fileRes.statusCode, 200, fileName);
      assert.ok(JSON.parse(fileRes.body).content.includes(expectedContent), fileName);
    }
  });
});
