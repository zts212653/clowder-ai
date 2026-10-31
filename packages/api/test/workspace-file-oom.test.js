/**
 * Regression tests for the Workspace file-preview OOM (F063).
 *
 * Bug: GET /api/workspace/file did `readFile(path,'utf-8')` on the WHOLE file
 * then `sha256(fullContent)`. Opening a large file, or a video with a
 * non-whitelisted extension (guessMime → 'text/plain'), read hundreds of MB into
 * a single JS string and flattened it for hashing → V8 heap OOM, process abort.
 * The file-watcher (computeFileSha256) had the SAME unguarded full read, and
 * re-ran it on every 1s watchdog poll.
 *
 * Fix contract:
 *  - never read more than MAX_PREVIEW_BYTES into memory
 *  - content containing NUL bytes ⇒ treated as binary (content:'', binary:true),
 *    regardless of file extension
 *  - truncated/large files ⇒ sha256:'' (NOT a full-content hash); this keeps the
 *    route and the watcher consistent so large files don't spuriously report
 *    "externally changed"
 *  - small text files unchanged (full content + full-content sha256)
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

const MAX_PREVIEW_BYTES = 1024 * 1024; // must match the route/helper constant

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function findWorktree() {
  const { listWorktrees } = await import('../dist/domains/workspace/workspace-security.js');
  const worktrees = await listWorktrees();
  const mine = worktrees.find((w) => w.root.endsWith('cat-cafe-workspace-file-oom'));
  return mine ?? worktrees[0];
}

describe('workspace /file OOM guard (F063)', () => {
  let app;
  let worktreeId;
  let wtRoot;
  const TEST_DIR = '__oom_guard_test__';

  before(async () => {
    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    const wt = await findWorktree();
    worktreeId = wt.id;
    wtRoot = wt.root;

    const base = join(wtRoot, TEST_DIR);
    await mkdir(base, { recursive: true });

    // 1.5 MB of text ⇒ exceeds MAX_PREVIEW_BYTES ⇒ truncated
    await writeFile(join(base, 'big.txt'), 'a'.repeat(Math.floor(MAX_PREVIEW_BYTES * 1.5)));
    // small text file
    await writeFile(join(base, 'hello.ts'), 'export const x = 1;\n');
    // "video" with non-whitelisted extension + NUL bytes ⇒ must be detected binary
    const fakeMkv = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // EBML/Matroska magic
      Buffer.alloc(4096, 0x00), // NUL-heavy binary body
    ]);
    await writeFile(join(base, 'movie.mkv'), fakeMkv);
    // whitelisted video extension (existing early-return path) — regression guard
    await writeFile(join(base, 'demo.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]));

    app = Fastify();
    await app.register(workspaceRoutes);
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await rm(join(wtRoot, TEST_DIR), { recursive: true, force: true });
  });

  const get = (path) =>
    app.inject({
      method: 'GET',
      url: `/api/workspace/file?worktreeId=${worktreeId}&path=${TEST_DIR}/${path}`,
    });

  it('bounds content and skips full-content hash for large text files', async () => {
    const res = await get('big.txt');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.truncated, true, 'large file must be flagged truncated');
    assert.ok(body.content.length <= MAX_PREVIEW_BYTES, 'content must be bounded to MAX_PREVIEW_BYTES');
    // The bug hashed the FULL content; the fix must NOT return a full-content hash.
    assert.equal(body.sha256, '', 'truncated file must not carry a full-content sha256');
  });

  it('detects non-whitelisted binary (video) by content, not extension', async () => {
    const res = await get('movie.mkv');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.binary, true, '.mkv with NUL bytes must be treated as binary');
    assert.equal(body.content, '', 'binary file must not return decoded text content');
  });

  it('still early-returns binary for whitelisted video extensions', async () => {
    const res = await get('demo.mp4');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.binary, true);
    assert.equal(body.content, '');
  });

  it('returns full content + full-content sha256 for small text files (no regression)', async () => {
    const res = await get('hello.ts');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.content, 'export const x = 1;\n');
    assert.equal(body.truncated, false);
    assert.equal(body.binary, false);
    assert.equal(body.sha256, sha256('export const x = 1;\n'));
  });
});

describe('workspace file-hash helper OOM guard (watcher path, F063)', () => {
  let mod;
  let wtRoot;
  const TEST_DIR = '__oom_helper_test__';

  before(async () => {
    mod = await import('../dist/domains/workspace/workspace-file-read.js');
    const wt = await findWorktree();
    wtRoot = wt.root;
    const base = join(wtRoot, TEST_DIR);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'big.log'), 'b'.repeat(Math.floor(MAX_PREVIEW_BYTES * 1.5)));
    await writeFile(join(base, 'small.txt'), 'hello\n');
    await writeFile(join(base, 'blob.bin'), Buffer.alloc(4096, 0x00));
  });

  after(async () => {
    await rm(join(wtRoot, TEST_DIR), { recursive: true, force: true });
  });

  it('exports computeWorkspaceFileSha256', () => {
    assert.equal(typeof mod.computeWorkspaceFileSha256, 'function');
  });

  it('returns empty hash for large files (no full read)', async () => {
    const sha = await mod.computeWorkspaceFileSha256(join(wtRoot, TEST_DIR, 'big.log'));
    assert.equal(sha, '');
  });

  it('returns empty hash for binary files', async () => {
    const sha = await mod.computeWorkspaceFileSha256(join(wtRoot, TEST_DIR, 'blob.bin'));
    assert.equal(sha, '');
  });

  it('returns full-content hash for small text files', async () => {
    const sha = await mod.computeWorkspaceFileSha256(join(wtRoot, TEST_DIR, 'small.txt'));
    assert.equal(sha, sha256('hello\n'));
  });
});

describe('route/watcher sha256 consistency for small media (F063 P1, codex review)', () => {
  let app;
  let mod;
  let worktreeId;
  let wtRoot;
  const TEST_DIR = '__oom_consistency_test__';
  // Known-media extension, < 1MB, NO NUL bytes in the prefix — the exact class
  // codex found: the route early-returns sha256:'' (knownBinary by extension) but
  // the watcher (content-sniff only) used to compute a non-empty hash, so opening
  // such a file fired a spurious workspace:file-changed on socket connect.
  const SMALL_MP3 = Buffer.from(`ID3${'A'.repeat(1021)}`, 'latin1'); // 1024 bytes, no NUL
  const SMALL_JPG = Buffer.from(`JFIF${'B'.repeat(1020)}`, 'latin1'); // 1024 bytes, no NUL

  before(async () => {
    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    mod = await import('../dist/domains/workspace/workspace-file-read.js');
    const wt = await findWorktree();
    worktreeId = wt.id;
    wtRoot = wt.root;
    const base = join(wtRoot, TEST_DIR);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'song.mp3'), SMALL_MP3);
    await writeFile(join(base, 'pic.jpg'), SMALL_JPG);

    app = Fastify();
    await app.register(workspaceRoutes);
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await rm(join(wtRoot, TEST_DIR), { recursive: true, force: true });
  });

  for (const name of ['song.mp3', 'pic.jpg']) {
    it(`route and watcher agree on empty hash for small media without NUL (${name})`, async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/workspace/file?worktreeId=${worktreeId}&path=${TEST_DIR}/${name}`,
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      const watcherSha = await mod.computeWorkspaceFileSha256(join(wtRoot, TEST_DIR, name));
      assert.equal(body.binary, true, `${name} must be treated as binary by the route`);
      assert.equal(body.sha256, '', `route must return empty sha256 for ${name}`);
      assert.equal(watcherSha, '', `watcher must return empty sha256 for ${name}`);
      assert.equal(body.sha256, watcherSha, `route/watcher hash must match for ${name}`);
    });
  }
});
