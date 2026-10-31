import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

describe('workspace absolute-document resolution', () => {
  let mod;

  beforeEach(async () => {
    mod = {
      ...(await import('../dist/domains/workspace/workspace-security.js')),
      ...(await import('../dist/domains/workspace/workspace-path-resolution.js')),
    };
  });

  it('resolves an absolute Markdown document to the longest registered worktree root', async () => {
    const outerRoot = join(tmpdir(), `document-root-${Date.now()}`);
    const nestedRoot = join(outerRoot, 'cat-cafe-feature');
    const documentPath = join(nestedRoot, 'docs', 'guide.mdx');
    await mkdir(join(nestedRoot, 'docs'), { recursive: true });
    await writeFile(documentPath, '# Guide\n');
    mod.registerWorktrees([
      { id: 'outer-worktree', root: outerRoot, branch: 'test', head: 'outer' },
      { id: 'feature-worktree', root: nestedRoot, branch: 'test', head: 'inner' },
    ]);

    try {
      assert.deepEqual(await mod.resolveWorkspaceDocumentHref(`${documentPath}:42`), {
        worktreeId: 'feature-worktree',
        path: 'docs/guide.mdx',
        line: 42,
      });
    } finally {
      await rm(outerRoot, { recursive: true, force: true });
    }
  });

  it('preserves literal percent signs in native absolute workspace paths', async () => {
    const registeredRoot = join(tmpdir(), `document-percent-${Date.now()}`);
    const percentDocument = join(registeredRoot, 'docs', '100%-done.md');
    const encodedLookingDocument = join(registeredRoot, 'docs', 'foo%20bar.md');
    await mkdir(join(registeredRoot, 'docs'), { recursive: true });
    await writeFile(percentDocument, '# Done\n');
    await writeFile(encodedLookingDocument, '# Literal percent\n');
    mod.registerWorktrees([{ id: 'document-percent', root: registeredRoot, branch: 'test', head: 'percent' }]);

    try {
      assert.deepEqual(await mod.resolveWorkspaceDocumentHref(percentDocument), {
        worktreeId: 'document-percent',
        path: 'docs/100%-done.md',
        line: null,
      });
      assert.deepEqual(await mod.resolveWorkspaceDocumentHref(encodedLookingDocument), {
        worktreeId: 'document-percent',
        path: 'docs/foo%20bar.md',
        line: null,
      });
      assert.deepEqual(await mod.resolveWorkspaceAbsolutePath(encodedLookingDocument), {
        worktreeId: 'document-percent',
        path: 'docs/foo%20bar.md',
        kind: 'file',
      });
    } finally {
      await rm(registeredRoot, { recursive: true, force: true });
    }
  });

  it('preserves a literal hash in a native absolute workspace path', async () => {
    const registeredRoot = join(tmpdir(), `document-hash-${Date.now()}`);
    const hashDocument = join(registeredRoot, 'docs', 'guide#draft.md');
    await mkdir(join(registeredRoot, 'docs'), { recursive: true });
    await writeFile(hashDocument, '# Draft\n');
    mod.registerWorktrees([{ id: 'document-hash', root: registeredRoot, branch: 'test', head: 'hash' }]);

    try {
      assert.deepEqual(await mod.resolveWorkspaceDocumentHref(`${hashDocument}:12`), {
        worktreeId: 'document-hash',
        path: 'docs/guide#draft.md',
        line: 12,
      });
    } finally {
      await rm(registeredRoot, { recursive: true, force: true });
    }
  });

  it('rejects absolute documents outside registered roots and sensitive Markdown-looking files', async () => {
    const registeredRoot = join(tmpdir(), `document-security-${Date.now()}`);
    const unknownRoot = join(tmpdir(), `document-unknown-${Date.now()}`);
    await mkdir(registeredRoot, { recursive: true });
    await mkdir(unknownRoot, { recursive: true });
    await writeFile(join(registeredRoot, '.env.md'), 'SECRET=123\n');
    await writeFile(join(unknownRoot, 'guide.md'), '# Unknown\n');
    mod.registerWorktrees([{ id: 'document-security', root: registeredRoot, branch: 'test', head: 'security' }]);

    try {
      await assert.rejects(
        () => mod.resolveWorkspaceDocumentHref(join(unknownRoot, 'guide.md')),
        (error) => error.code === 'NOT_FOUND',
      );
      await assert.rejects(
        () => mod.resolveWorkspaceDocumentHref(join(registeredRoot, '.env.md')),
        (error) => error.code === 'DENIED',
      );
      await assert.rejects(
        () => mod.resolveWorkspaceDocumentHref('/tmp/%E0%A4%A-guide.md'),
        (error) => error.code === 'NOT_FOUND',
      );
    } finally {
      await rm(registeredRoot, { recursive: true, force: true });
      await rm(unknownRoot, { recursive: true, force: true });
    }
  });

  it('rejects a Markdown symlink that escapes its registered worktree', async () => {
    const registeredRoot = join(tmpdir(), `document-symlink-${Date.now()}`);
    const externalRoot = join(tmpdir(), `document-external-${Date.now()}`);
    await mkdir(registeredRoot, { recursive: true });
    await mkdir(externalRoot, { recursive: true });
    await writeFile(join(externalRoot, 'outside.md'), '# Outside\n');
    await symlink(join(externalRoot, 'outside.md'), join(registeredRoot, 'linked.md'));
    mod.registerWorktrees([{ id: 'document-symlink', root: registeredRoot, branch: 'test', head: 'symlink' }]);

    try {
      await assert.rejects(
        () => mod.resolveWorkspaceDocumentHref(join(registeredRoot, 'linked.md')),
        (error) => error.code === 'TRAVERSAL',
      );
    } finally {
      await rm(registeredRoot, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});
