import type { ImmutableMedia } from '@cat-cafe/shared';
import sharp from 'sharp';

export const MAX_GIF_DECODE_PIXELS = 32_000_000;
export const MAX_GIF_FRAMES = 600;
export const MAX_GIF_BYTES = 10 * 1024 * 1024;

/** Shared byte admission, used before publishing and by immutable-owner inspection. Never rewrites the input. */
export async function probeGifImage(bytes: Buffer): Promise<Extract<ImmutableMedia, { kind: 'image' }>> {
  if (bytes.length < 13 || bytes.length > MAX_GIF_BYTES || !/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')))
    throw new Error('invalid_gif');
  const logicalWidth = bytes.readUInt16LE(6),
    logicalHeight = bytes.readUInt16LE(8);
  if (
    !logicalWidth ||
    !logicalHeight ||
    logicalWidth > 32768 ||
    logicalHeight > 32768 ||
    logicalWidth * logicalHeight > MAX_GIF_DECODE_PIXELS
  )
    throw new Error('invalid_gif');
  const decoder = sharp(bytes, { animated: true, limitInputPixels: MAX_GIF_DECODE_PIXELS, failOn: 'error' });
  const meta = await decoder.metadata();
  const frameCount = meta.pages ?? 1;
  const width = meta.width ?? 0,
    height = meta.pageHeight ?? meta.height ?? 0;
  if (
    meta.format !== 'gif' ||
    width !== logicalWidth ||
    height !== logicalHeight ||
    frameCount > MAX_GIF_FRAMES ||
    width * height * frameCount > MAX_GIF_DECODE_PIXELS
  )
    throw new Error('invalid_gif');
  const frameDelaysMs = meta.delay ?? [0];
  if (frameDelaysMs.length !== frameCount) throw new Error('invalid_gif');
  await decoder.timeout({ seconds: 5 }).stats();
  return {
    kind: 'image',
    width,
    height,
    animation: {
      frameCount,
      frameDelaysMs,
      durationMs: frameDelaysMs.reduce((a, b) => a + b, 0),
      loopCount: meta.loop ?? 1,
    },
  };
}
