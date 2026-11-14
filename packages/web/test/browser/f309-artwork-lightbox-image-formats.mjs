import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const sharp = requireApi('sharp');

/** Read the actual clipboard PNG and compare its decoded pixels with the requested original frame. */
export async function checkGifClipboardFrame(page, dialog, bytes, frameIndex) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('before GIF frame copy'));
  await dialog.getByRole('button', { name: '作品更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: /^复制图片/ }).click();
  await dialog.getByText('已复制图片', { exact: true }).waitFor({ state: 'visible' });
  // A previous success notice can still be visible; the text sentinel must be replaced by this PNG.
  const png = await page.evaluate(async () => {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      const item = (await navigator.clipboard.read()).find((entry) => entry.types.includes('image/png'));
      if (item) return Array.from(new Uint8Array(await (await item.getType('image/png')).arrayBuffer()));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('This GIF copy did not replace the clipboard sentinel with a PNG');
  });
  const actual = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const expected = await sharp(bytes, { page: frameIndex }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(actual.info.width, expected.info.width, 'clipboard is one logical GIF frame wide');
  assert.equal(actual.info.height, expected.info.height, 'clipboard is one logical GIF frame high');
  assert.deepEqual(
    actual.data,
    expected.data,
    'clipboard pixels match the displayed frame, not frame zero or the atlas',
  );
  return { frameIndex, width: actual.info.width, height: actual.info.height, bytes: png.length, pixelsMatch: true };
}

/** Asymmetric original pixels make a rotation or mirror error observable, rather than testing dimensions alone. */
export async function nativeImageBytes(kind, candidate = false) {
  const width = 480,
    height = 320;
  if (kind === 'svg')
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="-10 20 480 320"><defs><linearGradient id="g"><stop stop-color="${candidate ? '#446c86' : '#be6d47'}"/><stop offset="1" stop-color="#ead4a6"/></linearGradient></defs><rect x="-10" y="20" width="480" height="320" fill="url(#g)"/><circle id="sun" cx="${candidate ? 340 : 300}" cy="125" r="50" fill="#f5df9c"/><text x="30" y="260" font-size="28">Clowder AI · v${candidate ? 2 : 1}</text></svg>`,
    );
  if (kind === 'gif') {
    const frames = [];
    for (let frame = 0; frame < 3; frame++)
      frames.push(
        await sharp(
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="#f4e9d7"/><circle cx="${80 + frame * 130}" cy="145" r="50" fill="${candidate ? '#446c86' : '#be6d47'}"/><text x="30" y="280" font-size="28">FRAME ${frame + 1}</text></svg>`,
          ),
        )
          .ensureAlpha()
          .raw()
          .toBuffer(),
      );
    return sharp(Buffer.concat(frames), { raw: { width, height: height * 3, channels: 4, pageHeight: height } })
      .gif({ delay: [80, 180, 320], loop: 0 })
      .toBuffer();
  }
  const raw = Buffer.alloc(width * height * 3);
  const colors = candidate
    ? [
        [40, 80, 210],
        [210, 170, 30],
        [150, 50, 180],
        [30, 180, 160],
      ]
    : [
        [210, 50, 30],
        [30, 170, 70],
        [40, 80, 200],
        [220, 180, 30],
      ];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      raw.set(colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)], (y * width + x) * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation: kind === 'jpg' ? 6 : 7 })
    .toFormat(kind === 'jpg' ? 'jpeg' : 'webp')
    .toBuffer();
}

export async function checkNativeImageCoordinates(surface, bytes, media) {
  const image = surface.getByTestId('workspace-content-review-media');
  return checkNativeImagePixels(image, bytes, media);
}

export async function checkNativeImagePixels(image, bytes, media) {
  const displayed = await image.evaluate((img) => ({ width: img.naturalWidth, height: img.naturalHeight }));
  assert.deepEqual({ width: displayed.width, height: displayed.height }, { width: media.width, height: media.height });
  // Read the actual compositor pixels. Redrawing a cross-origin API image into a page canvas taints it,
  // even when it displays correctly; that would test origin policy rather than the work's orientation.
  const screenshot = await sharp(await image.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const screenOffset =
    (Math.floor(screenshot.info.height * 0.35) * screenshot.info.width + Math.floor(screenshot.info.width * 0.35)) * 3;
  displayed.pixel = [...screenshot.data.subarray(screenOffset, screenOffset + 3)];
  const normalized = await sharp(bytes).autoOrient().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset =
    (Math.floor(normalized.info.height * 0.35) * normalized.info.width + Math.floor(normalized.info.width * 0.35)) * 3;
  const expected = [...normalized.data.subarray(offset, offset + 3)];
  displayed.pixel.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) < 8, `EXIF displayed pixel ${index}`);
  });
  return { ...displayed, expectedPixel: expected };
}

export async function nativeWebpDisplayBytes(bytes) {
  return sharp(bytes).autoOrient().png().toBuffer();
}

export function checkNativeImageSelection(selection, media) {
  assert.equal(selection.kind, 'image-region');
  for (const [key, fraction, dimension] of [
    ['x', 0.25, media.width],
    ['y', 0.25, media.height],
    ['width', 0.3, media.width],
    ['height', 0.3, media.height],
  ])
    assert.ok(Math.abs(selection[key] - dimension * fraction) < 3, `display coordinate ${key}: ${selection[key]}`);
}
