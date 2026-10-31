/**
 * Integration tests for workspace file management endpoints — F063 Gap 4
 *
 * POST /api/workspace/file/create   — create new file
 * POST /api/workspace/dir/create    — create directory
 * POST /api/workspace/upload        — upload file (multipart)
 * DELETE /api/workspace/file        — delete file or empty dir
 * POST /api/workspace/file/rename   — rename/move file
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

// Public gates can run concurrently against the same discovered worktree.
// Keep each Node test process in its own directory so one suite cannot delete
// or overwrite another suite's fixtures between endpoint assertions.
const TEST_DIR = `__file_mgmt_test__-${process.pid}`;

describe('workspace file management endpoints', () => {
  let app;
  let worktreeId;
  let wtRoot;
  let editToken;

  before(async () => {
    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    const { workspaceEditRoutes } = await import('../dist/routes/workspace-edit.js');
    const { listWorktrees } = await import('../dist/domains/workspace/workspace-security.js');

    const worktrees = await listWorktrees();
    const thisWt = worktrees.find((w) => w.root.endsWith('cat-cafe-f063-gap4'));
    const wt = thisWt ?? worktrees[0];
    worktreeId = wt.id;
    wtRoot = wt.root;

    const testBase = join(wt.root, TEST_DIR);
    await mkdir(testBase, { recursive: true });
    await writeFile(join(testBase, 'existing.md'), '# Hello\n');

    app = Fastify();
    await app.register(workspaceRoutes);
    await app.register(workspaceEditRoutes);
    await app.ready();

    // Get an edit session token
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/workspace/edit-session',
      payload: { worktreeId },
    });
    editToken = JSON.parse(tokenRes.body).token;
  });

  after(async () => {
    await rm(join(wtRoot, TEST_DIR), { recursive: true, force: true });
    await app?.close();
  });

  // --- POST /api/workspace/file/create ---

  describe('POST /api/workspace/file/create', () => {
    it('creates a new file with content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/create',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/new-doc.md`,
          content: '# New Doc\n',
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.path, `${TEST_DIR}/new-doc.md`);
      assert.ok(body.sha256);

      const disk = await readFile(join(wtRoot, TEST_DIR, 'new-doc.md'), 'utf-8');
      assert.equal(disk, '# New Doc\n');
    });

    it('creates an empty file when content is omitted', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/create',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/empty.md`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 200);
      const disk = await readFile(join(wtRoot, TEST_DIR, 'empty.md'), 'utf-8');
      assert.equal(disk, '');
    });

    it('returns 409 if file already exists', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/create',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/existing.md`,
          content: 'overwrite attempt',
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 409);
    });

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/create',
        payload: { worktreeId, path: `${TEST_DIR}/notoken.md` },
      });
      assert.equal(res.statusCode, 401);
    });

    it('returns 403 for denylisted path', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/create',
        payload: {
          worktreeId,
          path: '.env.secret',
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  // --- POST /api/workspace/dir/create ---

  describe('POST /api/workspace/dir/create', () => {
    it('creates a new directory', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/dir/create',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/new-subdir`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 200);
      const s = await stat(join(wtRoot, TEST_DIR, 'new-subdir'));
      assert.ok(s.isDirectory());
    });

    it('creates nested directories (mkdir -p)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/dir/create',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/deep/nested/dir`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 200);
      const s = await stat(join(wtRoot, TEST_DIR, 'deep/nested/dir'));
      assert.ok(s.isDirectory());
    });

    it('succeeds silently if directory already exists', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/dir/create',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/new-subdir`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 200);
    });
  });

  // --- DELETE /api/workspace/file ---

  describe('DELETE /api/workspace/file', () => {
    it('deletes a file', async () => {
      // Create file first
      await writeFile(join(wtRoot, TEST_DIR, 'to-delete.txt'), 'bye');

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/workspace/file',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/to-delete.txt`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 200);

      await assert.rejects(stat(join(wtRoot, TEST_DIR, 'to-delete.txt')));
    });

    it('deletes an empty directory', async () => {
      await mkdir(join(wtRoot, TEST_DIR, 'empty-dir'), { recursive: true });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/workspace/file',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/empty-dir`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 200);
    });

    it('returns 404 for nonexistent file', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/workspace/file',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/ghost.txt`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 404);
    });

    it('returns 401 without token', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/workspace/file',
        payload: { worktreeId, path: `${TEST_DIR}/existing.md` },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  // --- POST /api/workspace/file/rename ---

  describe('POST /api/workspace/file/rename', () => {
    it('renames a file', async () => {
      await writeFile(join(wtRoot, TEST_DIR, 'old-name.md'), 'content');

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/rename',
        payload: {
          worktreeId,
          oldPath: `${TEST_DIR}/old-name.md`,
          newPath: `${TEST_DIR}/new-name.md`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 200);

      const disk = await readFile(join(wtRoot, TEST_DIR, 'new-name.md'), 'utf-8');
      assert.equal(disk, 'content');
      await assert.rejects(stat(join(wtRoot, TEST_DIR, 'old-name.md')));
    });

    it('returns 409 if target already exists', async () => {
      await writeFile(join(wtRoot, TEST_DIR, 'src-file.md'), 'src');
      await writeFile(join(wtRoot, TEST_DIR, 'dst-file.md'), 'dst');

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/rename',
        payload: {
          worktreeId,
          oldPath: `${TEST_DIR}/src-file.md`,
          newPath: `${TEST_DIR}/dst-file.md`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 409);
    });

    it('returns 404 if source does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/file/rename',
        payload: {
          worktreeId,
          oldPath: `${TEST_DIR}/nonexistent.md`,
          newPath: `${TEST_DIR}/whatever.md`,
          editSessionToken: editToken,
        },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  // --- POST /api/workspace/upload ---

  describe('POST /api/workspace/upload', () => {
    it('uploads a file via multipart', async () => {
      const boundary = '----TestBoundary123';
      const fileContent = Buffer.from('fake image data');
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="worktreeId"',
        '',
        worktreeId,
        `--${boundary}`,
        'Content-Disposition: form-data; name="path"',
        '',
        `${TEST_DIR}/uploaded.png`,
        `--${boundary}`,
        'Content-Disposition: form-data; name="editSessionToken"',
        '',
        editToken,
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="test.png"`,
        'Content-Type: image/png',
        '',
        fileContent.toString('binary'),
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });
      assert.equal(res.statusCode, 200);
      const resBody = JSON.parse(res.body);
      assert.equal(resBody.path, `${TEST_DIR}/uploaded.png`);
      assert.ok(resBody.size > 0);
    });

    it('returns 409 when uploading to existing file without overwrite flag', async () => {
      // existing.md was created in before()
      const boundary = '----TestBoundaryConflict';
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="worktreeId"',
        '',
        worktreeId,
        `--${boundary}`,
        'Content-Disposition: form-data; name="path"',
        '',
        `${TEST_DIR}/existing.md`,
        `--${boundary}`,
        'Content-Disposition: form-data; name="editSessionToken"',
        '',
        editToken,
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="existing.md"`,
        'Content-Type: text/markdown',
        '',
        '# Overwritten!',
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/upload',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      assert.equal(res.statusCode, 409, 'should reject upload to existing file');
      // Verify original content untouched
      const content = await readFile(join(wtRoot, TEST_DIR, 'existing.md'), 'utf8');
      assert.equal(content, '# Hello\n', 'original file should not be modified');
    });

    it('allows overwrite when overwrite=true query param is set', async () => {
      const boundary = '----TestBoundaryOverwrite';
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="worktreeId"',
        '',
        worktreeId,
        `--${boundary}`,
        'Content-Disposition: form-data; name="path"',
        '',
        `${TEST_DIR}/existing.md`,
        `--${boundary}`,
        'Content-Disposition: form-data; name="editSessionToken"',
        '',
        editToken,
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="existing.md"`,
        'Content-Type: text/markdown',
        '',
        '# Replaced!',
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/upload?overwrite=true',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      assert.equal(res.statusCode, 200, 'should allow overwrite with flag');
      const content = await readFile(join(wtRoot, TEST_DIR, 'existing.md'), 'utf8');
      assert.ok(content.includes('Replaced'), 'file should be overwritten');
    });

    it('returns 401 without token', async () => {
      const boundary = '----TestBoundary456';
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="worktreeId"',
        '',
        worktreeId,
        `--${boundary}`,
        'Content-Disposition: form-data; name="path"',
        '',
        `${TEST_DIR}/notoken.png`,
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="test.png"`,
        'Content-Type: image/png',
        '',
        'data',
        `--${boundary}--`,
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: '/api/workspace/upload',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });
      assert.equal(res.statusCode, 401);
    });
  });
});
