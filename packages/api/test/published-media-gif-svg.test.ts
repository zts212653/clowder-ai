import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { publishGeneratedImage } from '../src/domains/cats/services/agents/providers/generated-image-publication.js';
import { assertMediaAnchor } from '../src/domains/collaborative-content/artifact-review/anchors.js';
import { gifFrameAtlas } from '../src/domains/video-studio/content-owner/gif-image.js';
import { probeImmutableMedia } from '../src/domains/video-studio/content-owner/published-media-probe.js';
import { uploadsRoutes } from '../src/routes/uploads.js';
import { copyImageFileToUploadDir } from '../src/utils/image-storage.js';
import { disposalGif } from './helpers/disposal-gif.js';

async function gif() {
  const pixels = Buffer.alloc(4 * 8 * 4);
  for (let p = 0; p < pixels.length; p += 4) {
    pixels[p + (p < pixels.length / 2 ? 0 : 2)] = 255;
    pixels[p + 3] = p % 16 === 0 ? 0 : 255;
  }
  return sharp(pixels, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } })
    .gif({ delay: [80, 230], loop: 3 })
    .toBuffer();
}

test('GIF admission preserves logical canvas, variable frame clock and finite loop', async () => {
  const bytes = await gif();
  const media = await probeImmutableMedia(bytes, 'image/gif');
  assert.deepEqual(media, {
    kind: 'image',
    width: 4,
    height: 4,
    animation: { frameCount: 2, frameDelaysMs: [80, 230], durationMs: 310, loopCount: 3 },
  });
  assert.doesNotThrow(() =>
    assertMediaAnchor({ kind: 'image-region', x: 0, y: 0, width: 2, height: 2, frameIndex: 1, timestampMs: 80 }, media),
  );
  for (const anchor of [
    { kind: 'image-point', x: 1, y: 1 },
    { kind: 'image-point', x: 1, y: 1, frameIndex: 2, timestampMs: 310 },
    { kind: 'image-point', x: 1, y: 1, frameIndex: 1, timestampMs: 0 },
  ])
    assert.throws(() => assertMediaAnchor(anchor as Parameters<typeof assertMediaAnchor>[0], media), /invalid_anchor/);
});

test('SVG admission derives nonzero viewBox coordinates while preserving source', async () => {
  const bytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 20 120 80"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><path fill="url(#g)" d="M0 0h30v30z"/><text x="2" y="30">猫</text></svg>',
  );
  assert.deepEqual(await probeImmutableMedia(bytes, 'image/svg+xml'), {
    kind: 'image',
    width: 120,
    height: 80,
    viewBox: { minX: -10, minY: 20, width: 120, height: 80 },
  });
});

test('SVG derives a missing dimension from the viewBox aspect and only embeds verified still raster images', async () => {
  for (const [size, width, height] of [
    ['width="80"', 80, 40],
    ['height="80"', 160, 80],
    ['width="100%"', 40, 20],
  ] as const) {
    const admitted = await probeImmutableMedia(
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 40 20"/>`),
      'image/svg+xml',
    );
    assert.equal(admitted.width, width);
    assert.equal(admitted.height, height);
  }
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: 'blue' } })
    .png()
    .toBuffer();
  const svg = (data: Buffer) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image href="data:image/png;base64,${data.toString('base64')}"/></svg>`,
    );
  assert.equal((await probeImmutableMedia(svg(png), 'image/svg+xml')).kind, 'image');
  await assert.rejects(
    probeImmutableMedia(svg(Buffer.from('<svg onload="alert(1)"/>')), 'image/svg+xml'),
    /invalid_media/,
  );
  const moving = await gif();
  await assert.rejects(
    probeImmutableMedia(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image href="data:image/gif;base64,${moving.toString('base64')}"/></svg>`,
      ),
      'image/svg+xml',
    ),
    /invalid_media/,
  );
  const hugeEmbeddedCanvas = await sharp(png).gif().toBuffer();
  hugeEmbeddedCanvas.writeUInt16LE(8000, 6);
  hugeEmbeddedCanvas.writeUInt16LE(8000, 8);
  await assert.rejects(
    probeImmutableMedia(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image href="data:image/gif;base64,${hugeEmbeddedCanvas.toString('base64')}"/></svg>`,
      ),
      'image/svg+xml',
    ),
    /invalid_media/,
  );
});

test('SVG rejects active XML, event handlers, CSS/resource escapes, malformed and oversized input', async () => {
  for (const contents of [
    '<script>alert(1)</script>',
    '<g onload="alert(1)"/>',
    '<foreignObject/>',
    '<image href="https://example.test/a.png"/>',
    '<use href="file:///etc/passwd"/>',
    '<style>path{fill:url(https://example.test/x)}</style>',
    '<style>@import "https://example.test/x";</style>',
    '<style>path{fill:u\\72l(https://example.test/x)}</style>',
    '<image href="&#104;ttps://example.test/a.png"/>',
    '<animate attributeName="href"/>',
    '<svg xmlns="http://evil.example"><script/></svg>',
  ])
    await assert.rejects(
      probeImmutableMedia(
        Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">${contents}</svg>`),
        'image/svg+xml',
      ),
      /invalid_media/,
    );
  for (const raw of [
    '<!DOCTYPE svg [<!ENTITY a "oops">]><svg/>',
    '<svg width="20" height="20"><path></svg>',
    '<html/>',
    '<svg width="999999" height="999999"/>',
  ])
    await assert.rejects(probeImmutableMedia(Buffer.from(raw), 'image/svg+xml'), /invalid_media/);
});

test('a generated GIF named .png publishes exact bytes with GIF MIME/extension and retains its original source path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-gif-intake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await gif(),
    path = join(root, 'mislabeled.png');
  await writeFile(path, bytes);
  const input = {
    sourcePath: path,
    mimeType: 'image/png' as const,
    publicationKey: 'same-native-result',
    provider: 'codex' as const,
    toolName: 'image_gen',
    uploadDir: join(root, 'uploads'),
  };
  const result = await publishGeneratedImage(input);
  assert.equal(result.mimeType, 'image/gif');
  assert.match(result.urlPath, /\.gif$/);
  assert.equal(result.provenance.originalPath, path);
  assert.deepEqual(await readFile(result.absPath), bytes);
  await rm(path);
  const replay = await publishGeneratedImage(input);
  assert.equal(replay.urlPath, result.urlPath);
  assert.equal(replay.mimeType, 'image/gif');
  assert.equal(replay.isNew, false);
  assert.deepEqual(await readFile(replay.absPath), bytes);
  await writeFile(
    replay.absPath.replace(/\.gif$/, '.png'),
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer(),
  );
  await assert.rejects(publishGeneratedImage(input), /Publication key already names different image bytes/);
});

test('frame display projection retains frame pixels, transparency and unequal timing without changing its source', async () => {
  const bytes = await gif();
  const atlas = await sharp(await gifFrameAtlas(bytes))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(atlas.info.width, 8);
  assert.equal(atlas.info.height, 4);
  const pixel = (x: number) => [...atlas.data.subarray(x * 4, x * 4 + 4)];
  assert.deepEqual(pixel(1), [255, 0, 0, 255]);
  assert.deepEqual(pixel(5), [0, 0, 255, 255]);
  assert.equal(pixel(0)[3], 0);
  assert.equal(pixel(4)[3], 0);
  assert.equal((await sharp(bytes, { animated: true }).metadata()).pages, 2);
});

test('the GIF atlas coalesces partial frames with restore-background and restore-previous disposal', async () => {
  for (const disposal of [2, 3] as const) {
    const bytes = disposalGif(disposal);
    const media = await probeImmutableMedia(bytes, 'image/gif');
    assert.deepEqual(media.kind === 'image' && media.animation?.frameDelaysMs, [50, 110, 170]);
    const { data, info } = await sharp(await gifFrameAtlas(bytes))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x + 1) * 4)];
    assert.deepEqual(pixel(2, 0), [0, 0, 255, 255]);
    assert.deepEqual(pixel(3, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(1, 1), [0, 255, 0, 255]);
    if (disposal === 2) assert.equal(pixel(0, 1)[3], 0);
    else assert.deepEqual(pixel(0, 1), [255, 0, 0, 255]);
  }
});

test('reduced-motion cards receive frame zero while the downloadable GIF remains byte exact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-gif-poster-'));
  const bytes = disposalGif(3);
  await writeFile(join(root, 'original.gif'), bytes);
  const app = Fastify();
  await app.register(uploadsRoutes, { uploadDir: root });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await app.inject({ url: '/uploads/original.gif/gif-poster' })).statusCode, 401);
  const poster = await app.inject({
    url: '/uploads/original.gif/gif-poster',
    headers: { 'x-cat-cafe-user': 'operator' },
  });
  assert.equal(poster.statusCode, 200, poster.body);
  assert.equal(poster.headers['content-type'], 'image/png');
  const pixels = await sharp(poster.rawPayload).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...pixels], [255, 0, 0, 255, 255, 0, 0, 255]);
  assert.deepEqual((await app.inject({ url: '/uploads/original.gif' })).rawPayload, bytes);
});

test('GIF budgets follow cumulative decode resources rather than one generator API frame count', async () => {
  const pixels = Buffer.alloc(2 * 601 * 4);
  for (let index = 0; index < 601; index++) {
    pixels.fill(index % 2 ? 80 : 180, index * 8, (index + 1) * 8);
    pixels[index * 8 + 3] = 255;
    pixels[index * 8 + 7] = 255;
  }
  const within = await sharp(pixels.subarray(0, 64 * 8), { raw: { width: 2, height: 64, channels: 4, pageHeight: 1 } })
    .gif({ delay: 50 })
    .toBuffer();
  const admitted = await probeImmutableMedia(within, 'image/gif');
  assert.equal(admitted.kind === 'image' && admitted.animation?.frameCount, 64);
  const tooMany = await sharp(pixels, { raw: { width: 2, height: 601, channels: 4, pageHeight: 1 } })
    .gif({ delay: 50 })
    .toBuffer();
  await assert.rejects(probeImmutableMedia(tooMany, 'image/gif'), /invalid_media/);
  const hugeCanvas = Buffer.from(await gif());
  hugeCanvas.writeUInt16LE(8000, 6);
  hugeCanvas.writeUInt16LE(8000, 8);
  await assert.rejects(probeImmutableMedia(hugeCanvas, 'image/gif'), /invalid_media/);
  await assert.rejects(probeImmutableMedia(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/gif'), /invalid_media/);
});

test('the shared image copier identifies content and rejects SVG activity before publishing any file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-image-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'mislabeled.png'),
    bytes = await gif();
  await writeFile(path, bytes);
  const copied = await copyImageFileToUploadDir({
    sourcePath: path,
    mimeType: 'image/png',
    uploadDir: join(root, 'uploads'),
    filenameStem: 'original',
  });
  assert.match(copied.urlPath, /\.gif$/);
  assert.deepEqual(await readFile(copied.absPath), bytes);
  const unsafe = join(root, 'unsafe.svg');
  await writeFile(unsafe, '<svg width="4" height="4" onload="alert(1)"/>');
  await assert.rejects(
    copyImageFileToUploadDir({
      sourcePath: unsafe,
      mimeType: 'image/svg+xml',
      uploadDir: join(root, 'uploads'),
      filenameStem: 'unsafe',
    }),
    /Unsafe|unsupported/,
  );
  await assert.rejects(
    copyImageFileToUploadDir({
      sourcePath: unsafe,
      mimeType: 'image/png',
      uploadDir: join(root, 'uploads'),
      filenameStem: 'disguised',
    }),
    /Unsafe|unsupported/,
  );
});
