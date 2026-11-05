import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const sharp = requireApi('sharp');

/** Asymmetric original pixels make a rotation or mirror error observable, rather than testing dimensions alone. */
export async function nativeImageBytes(kind, candidate = false) {
  const width = 480,
    height = 320;
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
