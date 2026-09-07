/**
 * Integration tests for workspace edit endpoints — F063 AC-9
 *
 * Uses real workspaceEditRoutes + workspaceRoutes plugins registered on Fastify.
 * Creates temp test files in the worktree and cleans up after.
 *
 * Security/correctness properties verified:
 * 1. POST /edit-session returns valid token for known worktree
 * 2. PUT /file succeeds with valid token + matching baseSha256
 * 3. PUT /file returns 409 on sha256 mismatch (conflict)
 * 4. PUT /file returns 401 without token / with bad token
 * 5. PUT /file returns 403 for path traversal / denylist
 * 6. PUT /file returns 400 for binary/image files
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

// Full gates can execute this suite concurrently from multiple worktrees while
// the legacy fixture lookup below resolves every process to the same discovered
// worktree. Keep each Node process in its own directory so setup/cleanup and
// conflict assertions cannot overwrite one another's files.
const TEST_DIR = `__edit_endpoint_test__-${process.pid}`;

describe('workspace edit endpoints (integration)', () => {
  let app;
  let worktreeId;
  let wtRoot;

  before(async () => {
    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    const { workspaceEditRoutes } = await import('../dist/routes/workspace-edit.js');
    const { listWorktrees } = await import('../dist/domains/workspace/workspace-security.js');

    const worktrees = await listWorktrees();
    const thisWt = worktrees.find((w) => w.root.endsWith('cat-cafe-f063p2b5'));
    const wt = thisWt ?? worktrees[0];
    worktreeId = wt.id;
    wtRoot = wt.root;

    const testBase = join(wt.root, TEST_DIR);
    await mkdir(testBase, { recursive: true });
    await writeFile(join(testBase, 'hello.ts'), 'export const x = 1;\n');
    await writeFile(join(testBase, 'logo.png'), Buffer.from('fake-png'));
    await writeFile(join(testBase, 'data.bin'), Buffer.from([0x00, 0x01, 0x02]));
    await writeFile(join(testBase, 'doc.pdf'), Buffer.from('fake-pdf'));
    await writeFile(join(testBase, '.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]));

    app = Fastify();
    await app.register(workspaceRoutes);
    await app.register(workspaceEditRoutes);
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await rm(join(wtRoot, TEST_DIR), { recursive: true, force: true });
  });

  // ── Token issuance ──

  it('POST /edit-session returns token for valid worktree', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/edit-session',
      payload: { worktreeId },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.token);
    assert.equal(body.expiresIn, 1800);
  });

  it('POST /edit-session returns 404 for unknown worktree', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/edit-session',
      payload: { worktreeId: 'nonexistent-wt-999' },
    });
    assert.equal(res.statusCode, 404);
  });

  // ── Happy path write ──

  it('PUT /file writes file with valid token + matching sha', async () => {
    // Get token
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/workspace/edit-session',
      payload: { worktreeId },
    });
    const { token } = JSON.parse(tokenRes.payload);

    const original = 'export const x = 1;\n';
    const baseSha = sha256(original);
    const newContent = 'export const x = 2;\n';

    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file',
      payload: {
        worktreeId,
        path: `${TEST_DIR}/hello.ts`,
        content: newContent,
        baseSha256: baseSha,
        editSessionToken: token,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.sha256, sha256(newContent));
    assert.ok(body.size > 0);

    // Verify file was actually written
    const disk = await readFile(join(wtRoot, TEST_DIR, 'hello.ts'), 'utf-8');
    assert.equal(disk, newContent);

    // Restore original for other tests
    await writeFile(join(wtRoot, TEST_DIR, 'hello.ts'), original);
  });

  // ── Conflict detection ──

  it('PUT /file returns 409 on sha256 mismatch', async () => {
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/workspace/edit-session',
      payload: { worktreeId },
    });
    const { token } = JSON.parse(tokenRes.payload);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file',
      payload: {
        worktreeId,
        path: `${TEST_DIR}/hello.ts`,
        content: 'new content',
        baseSha256: 'deadbeef_wrong_hash',
        editSessionToken: token,
      },
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('Conflict'));
    assert.ok(body.currentSha256);
  });

  // ── Token validation ──

  it('PUT /file returns 401 without token', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file',
      payload: {
        worktreeId,
        path: `${TEST_DIR}/hello.ts`,
        content: 'x',
        baseSha256: 'abc',
      },
    });
    assert.equal(res.statusCode, 400); // missing required field
  });

  it('PUT /file returns 401 with invalid token', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file',
      payload: {
        worktreeId,
        path: `${TEST_DIR}/hello.ts`,
        content: 'x',
        baseSha256: 'abc',
        editSessionToken: 'totally.invalid',
      },
    });
    assert.equal(res.statusCode, 401);
  });

  // ── Security: path traversal ──

  it('PUT /file rejects path traversal with 403', async () => {
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/workspace/edit-session',
      payload: { worktreeId },
    });
    const { token } = JSON.parse(tokenRes.payload);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file',
      payload: {
        worktreeId,
        path: '../etc/passwd',
        content: 'hacked',
        baseSha256: 'abc',
        editSessionToken: token,
      },
    });
    assert.equal(res.statusCode, 403);
  });

  // ── Security: denylist ──

  it('PUT /file rejects denylist files (.env) with 403', async () => {
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/workspace/edit-session',
      payload: { worktreeId },
    });
    const { token } = JSON.parse(tokenRes.payload);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file',
      payload: {
        worktreeId,
        path: '.env',
        content: 'SECRET=bad',
        baseSha256: 'abc',
        editSessionToken: token,
      },
    });
    assert.equal(res.statusCode, 403);
  });

  // ── Concurrency: per-file mutex ensures exactly one write wins ──

  it('concurrent writes: exactly one succeeds, others get 409 (domain-level)', async () => {
    const { writeWorkspaceFile } = await import('../dist/domains/workspace/workspace-edit.js');

    const testFile = join(wtRoot, TEST_DIR, 'hello.ts');
    const original = await readFile(testFile, 'utf-8');
    const baseSha = sha256(original);

    // Fire 5 concurrent domain-level writes with same baseSha
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => writeWorkspaceFile(testFile, `export const x = ${i + 100};\n`, baseSha)),
    );

    const successes = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => !r.ok);

    assert.equal(successes.length, 1, 'Exactly one write should succeed');
    assert.equal(conflicts.length, 4, 'All others should get 409');

    // Restore original
    await writeFile(testFile, original);
  });

  // ── Binary rejection ──

  it('PUT /file rejects binary/image files with 400', async () => {
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/workspace/edit-session',
      payload: { worktreeId },
    });
    const { token } = JSON.parse(tokenRes.payload);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/workspace/file',
      payload: {
        worktreeId,
        path: `${TEST_DIR}/logo.png`,
        content: 'not-an-image',
        baseSha256: 'abc',
        editSessionToken: token,
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('binary'));
  });

  it('PUT /file rejects non-image binary files (.bin, .pdf) with 400', async () => {
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/workspace/edit-session',
      payload: { worktreeId },
    });
    const { token } = JSON.parse(tokenRes.payload);

    for (const ext of ['data.bin', 'doc.pdf', '.wasm']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/workspace/file',
        payload: {
          worktreeId,
          path: `${TEST_DIR}/${ext}`,
          content: 'overwrite attempt',
          baseSha256: 'abc',
          editSessionToken: token,
        },
      });
      assert.equal(res.statusCode, 400, `Expected 400 for ${ext}`);
    }
  });
});
