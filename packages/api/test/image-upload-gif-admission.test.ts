import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { validateDotPng } from '../src/domains/cats/services/cloud-bridge/dot/DotImageService.js';
import { saveUploadedImages } from '../src/routes/image-upload.js';
import { ImageUploadError, saveImageBufferToUploadDir } from '../src/utils/image-storage.js';
import { disposalGif } from './helpers/disposal-gif.js';

/** Repeat a complete, genuinely encoded frame without allocating a large raw animation fixture. */
async function repeatedGif(width: number, height: number, count: number) {
  const still = await sharp({ create: { width, height, channels: 3, background: '#be6d47' } })
    .gif({ delay: 50, loop: 1 })
    .toBuffer();
  const paletteBytes = still[10] & 0x80 ? 3 * 2 ** ((still[10] & 7) + 1) : 0;
  const start = 13 + paletteBytes;
  const bytes = Buffer.concat([
    still.subarray(0, start),
    ...Array.from({ length: count }, () => still.subarray(start, -1)),
    Buffer.from([0x3b]),
  ]);
  const meta = await sharp(bytes, { animated: true, limitInputPixels: false }).metadata();
  assert.equal(meta.pages, count);
  await sharp(bytes, { page: count - 1, pages: 1 }).stats();
  return bytes;
}

const hugeCanvas = Buffer.from(disposalGif(2));
hugeCanvas.writeUInt16LE(8000, 6);
hugeCanvas.writeUInt16LE(8000, 8);
const rejected = [
  ['601 frames', await repeatedGif(2, 1, 601)],
  ['33 million cumulative pixels', await repeatedGif(1000, 1000, 33)],
  ['64 million logical canvas pixels', hugeCanvas],
  ['GIF signature without a valid image', Buffer.from('474946383961020001000000003b', 'hex')],
] as const;

const entries = [
  {
    name: 'ordinary multipart',
    save: async (bytes: Buffer, uploadDir: string) =>
      (await saveUploadedImages([{ mimetype: 'image/png', toBuffer: async () => bytes }], uploadDir))[0],
  },
  {
    name: 'shared writer used by Dot',
    save: (bytes: Buffer, uploadDir: string) =>
      saveImageBufferToUploadDir({ buffer: bytes, mimeType: 'image/png', uploadDir, filenameStem: 'source' }),
  },
] as const;

for (const entry of entries) {
  for (const [name, bytes] of rejected)
    test(`${entry.name} refuses ${name} before creating any upload`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'f309-gif-reject-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await assert.rejects(entry.save(bytes, root), ImageUploadError);
      assert.deepEqual(await readdir(root), []);
    });

  for (const disposal of [2, 3] as const)
    test(`${entry.name} preserves the complete GIF with variable delay, transparency and disposal ${disposal}`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'f309-gif-accept-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const bytes = disposalGif(disposal);
      const saved = await entry.save(bytes, root);
      assert.match(saved.urlPath, /\.gif$/);
      const actual = await readFile(saved.absPath);
      assert.deepEqual(actual, bytes);
      const meta = await sharp(actual, { animated: true }).metadata();
      assert.deepEqual([meta.width, meta.pageHeight, meta.pages, meta.delay, meta.loop], [2, 1, 3, [50, 110, 170], 0]);
      const last = await sharp(actual, { page: 2, pages: 1 }).ensureAlpha().raw().toBuffer();
      assert.deepEqual([...last.subarray(4, 8)], [0, 255, 0, 255]);
      assert.equal(last[3], disposal === 2 ? 0 : 255);
    });
}

test('Dot retains its PNG-only input contract and passes the checked original to the shared writer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-dot-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(validateDotPng(disposalGif(2).toString('base64')), /invalid_png/);
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const checked = await validateDotPng(bytes.toString('base64'));
  const stored = await saveImageBufferToUploadDir({
    buffer: checked.bytes,
    mimeType: 'image/png',
    uploadDir: root,
    filenameStem: 'dot',
  });
  assert.deepEqual(await readFile(stored.absPath), bytes);
});
