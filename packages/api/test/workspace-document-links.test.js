import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { EventAuditLog } from '../dist/domains/cats/services/orchestration/EventAuditLog.js';
import { registerWorktrees } from '../dist/domains/workspace/workspace-security.js';
import { workspaceRoutes } from '../dist/routes/workspace.js';

const NAVIGATE_HEADERS = { 'x-cat-cafe-user': 'default-user' };

describe('F293 chat Workspace path links', () => {
  const app = Fastify();
  const emittedEvents = [];
  const appendedAuditEvents = [];
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const canonicalWorktreeId = basename(repoRoot).replace(/[^a-zA-Z0-9_-]/g, '_');

  before(async () => {
    registerWorktrees([{ id: 'test-wt', root: repoRoot, branch: 'main', head: 'abc123' }]);
    const auditLog = new EventAuditLog({ auditDir: '/tmp/cat-cafe-workspace-document-links-audit-test' });
    auditLog.append = async (input) => {
      appendedAuditEvents.push(input);
      return {
        id: 'audit-1',
        timestamp: Date.now(),
        ...input,
      };
    };

    await app.register(workspaceRoutes, {
      socketEmit: (event, data, room) => {
        emittedEvents.push({ event, data, room });
      },
      auditLog,
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('resolves an absolute Markdown document link to a typed Workspace target', async () => {
    const href = resolve(repoRoot, 'docs/features/F063-hub-workspace-explorer.md');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { href: `${href}:59` },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      worktreeId: canonicalWorktreeId,
      path: 'docs/features/F063-hub-workspace-explorer.md',
      line: 59,
      kind: 'file',
    });
  });

  it('resolves absolute non-Markdown files and line suffixes to typed Workspace targets', async () => {
    const href = `${resolve(repoRoot, 'packages/web/src/components/ChatWorkspaceLink.tsx')}:42`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { href },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      worktreeId: canonicalWorktreeId,
      path: 'packages/web/src/components/ChatWorkspaceLink.tsx',
      line: 42,
      kind: 'file',
    });
  });

  it('resolves Codex line and column suffixes to the requested source line', async () => {
    const href = `${resolve(repoRoot, 'packages/web/src/components/ChatWorkspaceLink.tsx')}:42:7`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { href },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      worktreeId: canonicalWorktreeId,
      path: 'packages/web/src/components/ChatWorkspaceLink.tsx',
      line: 42,
      kind: 'file',
    });
  });

  it('resolves line suffixes through an alias of a registered worktree root', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-workspace-root-alias-'));
    const aliasRoot = join(temporaryRoot, 'workspace-alias');
    try {
      await symlink(repoRoot, aliasRoot, 'dir');
      const aliasedFilePath = join(aliasRoot, 'packages/web/src/components/ChatWorkspaceLink.tsx');

      for (const [suffix, line] of [
        [':42', 42],
        [':42:7', 42],
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/workspace/resolve-document-link',
          headers: { 'x-cat-cafe-user': 'default-user' },
          payload: { href: `${aliasedFilePath}${suffix}` },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(JSON.parse(res.body), {
          worktreeId: canonicalWorktreeId,
          path: 'packages/web/src/components/ChatWorkspaceLink.tsx',
          line,
          kind: 'file',
        });
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('treats an existing path ending in a numeric colon suffix as a literal filename', async () => {
    const href = resolve(repoRoot, 'packages/api/test/__chat-link-colon-name.txt:42');
    await writeFile(href, 'fixture');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/resolve-document-link',
        headers: { 'x-cat-cafe-user': 'default-user' },
        payload: { href },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.body), {
        worktreeId: canonicalWorktreeId,
        path: 'packages/api/test/__chat-link-colon-name.txt:42',
        line: null,
        kind: 'file',
      });

      const lineRes = await app.inject({
        method: 'POST',
        url: '/api/workspace/resolve-document-link',
        headers: { 'x-cat-cafe-user': 'default-user' },
        payload: { href: `${href}:1` },
      });

      assert.equal(lineRes.statusCode, 200);
      assert.deepEqual(JSON.parse(lineRes.body), {
        worktreeId: canonicalWorktreeId,
        path: 'packages/api/test/__chat-link-colon-name.txt:42',
        line: 1,
        kind: 'file',
      });
    } finally {
      await unlink(href);
    }
  });

  it('prefers line-column syntax when a colon-suffixed filename also exists', async () => {
    const fixtureRoot = await mkdtemp(join(repoRoot, 'packages/api/test/__chat-link-suffix-priority-'));
    const sourcePath = join(fixtureRoot, 'source.ts');
    const literalPath = `${sourcePath}:42`;

    try {
      await writeFile(sourcePath, 'source');
      await writeFile(literalPath, 'literal');
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/resolve-document-link',
        headers: { 'x-cat-cafe-user': 'default-user' },
        payload: { href: `${literalPath}:1` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.body), {
        worktreeId: canonicalWorktreeId,
        path: `packages/api/test/${basename(fixtureRoot)}/source.ts`,
        line: 42,
        kind: 'file',
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('resolves absolute directory links to typed Workspace targets', async () => {
    const href = resolve(repoRoot, 'packages/web/src/components');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { href },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      worktreeId: canonicalWorktreeId,
      path: 'packages/web/src/components',
      line: null,
      kind: 'directory',
    });
  });

  it('rejects document links outside registered worktrees', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { href: '/definitely/not/registered/image.png' },
    });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { code: 'PATH_NOT_IN_REGISTERED_WORKSPACE' });
  });

  it('distinguishes a missing path inside a registered worktree', async () => {
    const href = resolve(repoRoot, 'packages/web/src/components/__missing_chat_workspace_link__.png');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { href },
    });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { code: 'PATH_NOT_FOUND' });
  });

  it('returns a stable access-denied code without exposing the rejected path segment', async () => {
    const href = resolve(repoRoot, '.env.local');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { href },
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(JSON.parse(res.body), { code: 'PATH_ACCESS_DENIED' });
  });

  it('returns the generic resolver code for malformed non-absolute paths', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      headers: { 'x-cat-cafe-user': 'default-user' },
      payload: { href: 'relative/file.ts' },
    });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body), { code: 'PATH_RESOLUTION_FAILED' });
  });

  it('rejects an unauthenticated document resolver request before exposing filesystem truth', async () => {
    const href = resolve(repoRoot, 'docs/features/F063-hub-workspace-explorer.md');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-document-link',
      payload: { href },
    });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(JSON.parse(res.body), { code: 'AUTHENTICATION_REQUIRED' });
  });

  it('accepts a Codex-native absolute path without worktreeId and emits a relative typed target', async () => {
    emittedEvents.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/navigate',
      headers: NAVIGATE_HEADERS,
      payload: { path: resolve(repoRoot, 'package.json'), action: 'open', line: 7 },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.path, 'package.json');
    assert.equal(body.worktreeId, canonicalWorktreeId);
    assert.equal(emittedEvents[0].data.path, 'package.json');
    assert.equal(emittedEvents[0].data.worktreeId, canonicalWorktreeId);
    assert.equal(emittedEvents[0].data.line, 7);
  });
});
