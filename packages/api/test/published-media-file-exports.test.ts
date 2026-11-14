import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { LocalMediaFileDigest } from '../src/domains/video-studio/content-owner/local-media-file-digest.js';
import {
  LocalMediaFileUnavailable,
  mediaExportFilename,
  PublishedMediaFileExports,
} from '../src/domains/video-studio/content-owner/published-media-file-exports.js';
import { MAX_STREAM_CONTENT_BYTES } from '../src/domains/video-studio/content-owner/stream-content.js';

const posixFiles = {
  skip:
    process.platform === 'win32'
      ? 'Native export privacy requires POSIX directory modes (node:fs chmod); desktop actions are macOS-only'
      : false,
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'media-export-'));
  const original = join(root, 'canonical');
  const bytes = Buffer.from('immutable owner media bytes');
  await writeFile(original, bytes);
  const handle = await open(original);
  t.after(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });
  const blobDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const directory = join(root, 'open-exports');
  return {
    root,
    original,
    bytes,
    directory,
    exports: new PublishedMediaFileExports(directory),
    source: { handle, byteLength: bytes.length, blobDigest, mediaType: 'video/mp4' },
  };
}

test(
  'repeated/concurrent export uses one private, read-only independent inode with the MIME extension',
  posixFiles,
  async (t) => {
    const f = await fixture(t);
    const paths = await Promise.all(Array.from({ length: 12 }, () => f.exports.materialize(f.source, '同一作品')));
    assert.equal(new Set(paths).size, 1);
    const path = paths[0];
    assert.ok(path);
    assert.equal(basename(path), '同一作品.mp4');
    assert.deepEqual(await readFile(path), f.bytes);
    const copied = await lstat(path),
      original = await lstat(f.original);
    assert.equal(copied.nlink, 1);
    assert.equal(copied.mode & 0o222, 0);
    assert.notEqual(copied.ino, original.ino);
    assert.equal((await lstat(dirname(path))).mode & 0o777, 0o700);
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(dirname(path)), ['同一作品.mp4']);
  },
);

test('tampered or writable export is replaced without changing the canonical file', posixFiles, async (t) => {
  const f = await fixture(t);
  const path = await f.exports.materialize(f.source, 'copy');
  await chmod(path, 0o600);
  await writeFile(path, 'external save');
  assert.deepEqual(await readFile(f.original), f.bytes);
  assert.equal(await f.exports.materialize(f.source, 'copy'), path);
  assert.deepEqual(await readFile(path), f.bytes);
  assert.equal((await lstat(path)).mode & 0o222, 0);
});

test('a mode-only change repairs the copy even when its digest is unchanged', posixFiles, async (t) => {
  const f = await fixture(t);
  const path = await f.exports.materialize(f.source, 'copy');
  await chmod(path, 0o644);
  assert.equal(await f.exports.materialize(f.source, 'copy'), path);
  assert.equal((await lstat(path)).mode & 0o222, 0);
  assert.deepEqual(await readFile(path), f.bytes);
  assert.deepEqual(await readFile(f.original), f.bytes);
});

test('a digest directory with group or public access is refused', posixFiles, async (t) => {
  const f = await fixture(t);
  const directory = join(f.directory, f.source.blobDigest.slice(7));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o755);
  await assert.rejects(f.exports.materialize(f.source, 'copy'), LocalMediaFileUnavailable);
  assert.deepEqual(await readdir(directory), []);
});

test('a hardlink or symlink at the export leaf is replaced rather than followed', posixFiles, async (t) => {
  const f = await fixture(t);
  const path = await f.exports.materialize(f.source, 'copy');
  for (const create of [link, symlink]) {
    await unlink(path);
    await create(f.original, path);
    assert.equal(await f.exports.materialize(f.source, 'copy'), path);
    assert.equal((await lstat(path)).isSymbolicLink(), false);
    assert.equal((await lstat(path)).nlink, 1);
    assert.notEqual((await lstat(path)).ino, (await lstat(f.original)).ino);
    assert.deepEqual(await readFile(f.original), f.bytes);
  }
});

test(
  'a symlinked digest directory is refused without creating files outside the export root',
  posixFiles,
  async (t) => {
    const f = await fixture(t);
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await mkdir(f.directory, { mode: 0o700 });
    await symlink(outside, join(f.directory, f.source.blobDigest.slice(7)));
    await assert.rejects(f.exports.materialize(f.source, 'copy'), /无法准备/);
    assert.deepEqual(await readdir(outside), []);
  },
);

test('wrong source bytes cannot publish a partial or incorrectly named export', posixFiles, async (t) => {
  const f = await fixture(t);
  const wrong = { ...f.source, blobDigest: `sha256:${'0'.repeat(64)}` };
  await assert.rejects(f.exports.materialize(wrong, 'copy'), /无法准备/);
  assert.deepEqual(await readdir(join(f.directory, '0'.repeat(64))), []);
  await assert.rejects(f.exports.materialize({ ...f.source, mediaType: 'text/html' }, 'copy'), /不支持/);
});

test('unsupported types and owner-overlimit media fail permanently before publishing a copy', posixFiles, async (t) => {
  const f = await fixture(t);
  for (const source of [
    { ...f.source, mediaType: 'text/html' },
    { ...f.source, byteLength: MAX_STREAM_CONTENT_BYTES + 1 },
  ]) {
    await assert.rejects(
      f.exports.materialize(source, 'copy'),
      (error: unknown) => error instanceof LocalMediaFileUnavailable && !error.message.includes('稍后重试'),
    );
  }
  await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
});

test('only transient copy failures invite retry and neither failure publishes a file', posixFiles, async (t) => {
  const f = await fixture(t);
  for (const code of ['EACCES', 'EAGAIN']) {
    const read = t.mock.method(f.source.handle, 'read', async () => {
      throw Object.assign(new Error('isolated copy failure'), { code });
    });
    await assert.rejects(f.exports.materialize(f.source, 'copy'), (error: unknown) => {
      assert.ok(error instanceof LocalMediaFileUnavailable);
      assert.equal(error.message.includes('稍后重试'), code === 'EAGAIN');
      return true;
    });
    read.mock.restore();
    assert.deepEqual(await readdir(join(f.directory, f.source.blobDigest.slice(7))), []);
  }
});

test('export filenames are bounded leaves and their extension comes only from reviewed MIME', () => {
  for (const [mime, extension] of [
    ['video/mp4', '.mp4'],
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/webp', '.webp'],
  ] as const) {
    const name = mediaExportFilename(`../\0/\\evil\u202e${'🐾'.repeat(120)}.mp4`, mime);
    assert.equal(basename(name), name);
    assert.ok(!name.startsWith('.'));
    assert.ok(name.endsWith(extension));
    assert.ok(Buffer.byteLength(name) < 200);
    assert.ok(!/[\p{Cc}\p{Cf}/\\]/u.test(name));
  }
});

test('cached digest cannot survive same-size edits with restored mtime or replacement inodes', async (t) => {
  const f = await fixture(t);
  const cache = new LocalMediaFileDigest();
  assert.equal(await cache.matches(f.original, f.source.blobDigest), true);
  const before = await lstat(f.original);
  await writeFile(f.original, Buffer.alloc(f.bytes.length, 42));
  await utimes(f.original, before.atime, before.mtime);
  assert.equal(await cache.matches(f.original, f.source.blobDigest), false);
  await unlink(f.original);
  await writeFile(f.original, f.bytes);
  assert.equal(await cache.matches(f.original, f.source.blobDigest), true);
});
