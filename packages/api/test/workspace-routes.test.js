import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('workspace-routes', () => {
  let mod;

  before(async () => {
    mod = await import('../dist/routes/workspace.js');
  });

  it('exports workspaceRoutes as FastifyPluginAsync', () => {
    assert.ok(typeof mod.workspaceRoutes === 'function');
  });

  // Integration tests for actual HTTP responses are covered by
  // the security layer tests (workspace-security.test.js) and
  // manual smoke testing against the running dev server.
  // The route handlers are thin wrappers around security + fs operations.
});

describe('current discovery root identity', () => {
  let app;
  let testRoot;
  let previousRoot;
  let otherRoot;
  before(async () => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'warm-root-http-')));
    execFileSync('git', ['init', '--quiet', testRoot]);
    otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'warm-root-other-')));
    execFileSync('git', ['init', '--quiet', otherRoot]);
    writeFileSync(join(testRoot, 'original.md'), '# Original root');
    previousRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    process.env.CAT_CAFE_WORKSPACE_ROOT = testRoot;
    app = Fastify();
    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    await app.register(workspaceRoutes);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    if (previousRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    else process.env.CAT_CAFE_WORKSPACE_ROOT = previousRoot;
    rmSync(testRoot, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  });
  it('does not turn discovery metadata or a stale canonical root into a new filesystem grant', async () => {
    const { durableIdForCanonicalRoot } = await import('../dist/domains/workspace/workspace-worktree-identity.js');
    const rootId = durableIdForCanonicalRoot(testRoot);
    const discovery = await app.inject(`/api/workspace/worktrees?repoRoot=${encodeURIComponent(testRoot)}`);
    assert.equal(discovery.statusCode, 200);
    process.env.CAT_CAFE_WORKSPACE_ROOT = otherRoot;
    try {
      const stale = await app.inject(`/api/workspace/tree?worktreeId=${rootId}`);
      assert.equal(stale.statusCode, 404);
      assert.equal(stale.json().tree, undefined);
    } finally {
      process.env.CAT_CAFE_WORKSPACE_ROOT = testRoot;
    }
  });
  it('advertises the same F063 owner identity without replacing listing ids or epoch', async () => {
    const { durableIdForCanonicalRoot } = await import('../dist/domains/workspace/workspace-worktree-identity.js');
    const res = await app.inject(`/api/workspace/worktrees?repoRoot=${encodeURIComponent(testRoot)}`);
    assert.equal(res.statusCode, 200);
    const entry = res.json().worktrees.find((item) => item.resolvedRoot === testRoot);
    assert.ok(entry);
    assert.equal(entry.rootIdentity, durableIdForCanonicalRoot(testRoot));
    assert.notEqual(entry.id, entry.rootIdentity);
    assert.equal(entry.rootEpoch, 0);
    const tree = await app.inject(`/api/workspace/tree?worktreeId=${entry.rootIdentity}`);
    assert.equal(tree.statusCode, 200);
    assert.ok(tree.json().tree.some((item) => item.path === 'original.md'));
  });
  it('keeps the original default-discovery pane id without adding a canonical display alias', async () => {
    const { listWorktrees } = await import('../dist/domains/workspace/workspace-security.js');
    const { durableIdForCanonicalRoot } = await import('../dist/domains/workspace/workspace-worktree-identity.js');
    const repoRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
    const listed = (await listWorktrees()).find((item) => realpathSync(item.root) === repoRoot);
    assert.ok(listed);
    const res = await app.inject('/api/workspace/worktrees');
    assert.equal(res.statusCode, 200);
    const entry = res.json().worktrees.find((item) => item.resolvedRoot === repoRoot);
    assert.ok(entry);
    assert.equal(entry.id, listed.id);
    assert.equal(entry.canonicalId ?? null, null);
    assert.equal(entry.rootIdentity, durableIdForCanonicalRoot(repoRoot));
  });
});
