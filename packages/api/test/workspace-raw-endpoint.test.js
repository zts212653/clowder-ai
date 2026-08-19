/**
 * Integration tests for GET /api/workspace/file/raw — F063 AC-8 image preview + Gap 5 media
 *
 * Uses the REAL workspaceRoutes plugin (not a mirror), injecting against
 * the actual production route handler. Test files are created in a temp
 * subdirectory of this worktree and cleaned up after.
 *
 * Security properties verified:
 * 1. Only media MIME types served (image/audio/video; others → 400)
 * 2. Path traversal/denylist inherited from resolveWorkspacePath
 * 3. Correct Content-Type / Content-Length headers
 * 4. Missing params → 400, nonexistent file → 404
 */

import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

// 1x1 transparent PNG (68 bytes)
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' + 'Nl7BcQAAAABJRU5ErkJggg==',
  'base64',
);

describe('workspace file/raw endpoint (integration)', () => {
  let app;
  let worktreeId;
  const TEST_DIR = '__raw_endpoint_test__';

  before(async () => {
    // Import real route plugin and security module
    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    const { listWorktrees } = await import('../dist/domains/workspace/workspace-security.js');

    // Find this worktree's ID
    const worktrees = await listWorktrees();
    const thisWt = worktrees.find((w) => w.root.endsWith('cat-cafe-f063p2b4'));
    // Fallback: use the main worktree if this one isn't found
    const wt = thisWt ?? worktrees[0];
    worktreeId = wt.id;

    // Create temp test files inside the worktree root
    const testBase = join(wt.root, TEST_DIR);
    await mkdir(testBase, { recursive: true });
    await writeFile(join(testBase, 'logo.png'), TINY_PNG);
    await writeFile(join(testBase, 'photo.jpg'), TINY_PNG); // fake jpg
    await writeFile(join(testBase, 'literal%20image.png'), Buffer.from([0x11, 0x22, 0x33]));
    await writeFile(join(testBase, 'literal image.png'), Buffer.from([0x44, 0x55, 0x66]));
    await writeFile(join(testBase, 'code.ts'), 'export {}');
    // Fake audio/video files (content doesn't matter for MIME routing)
    await writeFile(join(testBase, 'clip.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    await writeFile(join(testBase, 'demo.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x1c]));

    // Register real workspaceRoutes on a Fastify instance
    app = Fastify();
    await app.register(workspaceRoutes);
    await app.ready();
  });

  after(async () => {
    await app?.close();
    // Clean up test files — find the worktree root from the resolved path
    const { listWorktrees } = await import('../dist/domains/workspace/workspace-security.js');
    const worktrees = await listWorktrees();
    const thisWt = worktrees.find((w) => w.root.endsWith('cat-cafe-f063p2b4'));
    const wt = thisWt ?? worktrees[0];
    await rm(join(wt.root, TEST_DIR), { recursive: true, force: true });
  });

  // ── Image files served correctly via real route ──

  it('serves PNG with correct Content-Type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?worktreeId=${worktreeId}&path=${TEST_DIR}/logo.png`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.ok(Number(res.headers['content-length']) > 0);
    assert.equal(res.headers['cache-control'], 'private, max-age=60');
  });

  it('serves JPG with correct Content-Type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?worktreeId=${worktreeId}&path=${TEST_DIR}/photo.jpg`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/jpeg');
  });

  it('preserves native percent bytes in raw media paths', async () => {
    const query = new URLSearchParams({
      worktreeId,
      path: `${TEST_DIR}/literal%20image.png`,
    });
    const res = await app.inject({ method: 'GET', url: `/api/workspace/file/raw?${query}` });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, Buffer.from([0x11, 0x22, 0x33]));
  });

  // ── Audio/video files served (Gap 5) ──

  it('serves MP3 with correct Content-Type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?worktreeId=${worktreeId}&path=${TEST_DIR}/clip.mp3`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.ok(Number(res.headers['content-length']) > 0);
  });

  it('serves MP4 with correct Content-Type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?worktreeId=${worktreeId}&path=${TEST_DIR}/demo.mp4`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'video/mp4');
  });

  // ── Non-media files rejected ──

  it('rejects non-media files with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?worktreeId=${worktreeId}&path=${TEST_DIR}/code.ts`,
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('image'));
  });

  // ── Security inheritance from resolveWorkspacePath ──

  it('rejects path traversal (../) with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?worktreeId=${worktreeId}&path=../etc/passwd`,
    });
    assert.equal(res.statusCode, 403);
  });

  it('rejects denylist files (.env) with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?worktreeId=${worktreeId}&path=.env`,
    });
    assert.equal(res.statusCode, 403);
  });

  // ── Missing params ──

  it('rejects missing worktreeId with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?path=${TEST_DIR}/logo.png`,
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects missing path with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?worktreeId=${worktreeId}`,
    });
    assert.equal(res.statusCode, 400);
  });

  // ── File not found ──

  it('returns 404 for nonexistent image', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/file/raw?worktreeId=${worktreeId}&path=${TEST_DIR}/missing.png`,
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('workspace reveal endpoint', () => {
  let app;
  let worktreeId;

  before(async () => {
    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    const { listWorktrees } = await import('../dist/domains/workspace/workspace-security.js');
    const worktrees = await listWorktrees();
    const wt = worktrees[0];
    worktreeId = wt.id;

    app = Fastify();
    await app.register(workspaceRoutes);
    await app.ready();
  });

  after(async () => {
    await app?.close();
  });

  it('rejects missing worktreeId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/reveal',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ path: 'README.md' }),
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects missing path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/reveal',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ worktreeId }),
    });
    assert.equal(res.statusCode, 400);
  });

  it('rejects path traversal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/reveal',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ worktreeId, path: '../../etc/passwd' }),
    });
    // resolveWorkspacePath may return 403 or 404 depending on traversal detection
    assert.ok([403, 404].includes(res.statusCode));
  });
});
