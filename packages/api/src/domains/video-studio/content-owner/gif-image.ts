import { gifAtlasLayout, type ImmutableMedia } from '@cat-cafe/shared';
import sharp from 'sharp';
import { MAX_GIF_DECODE_PIXELS, probeGifImage } from '../../../utils/gif-image.js';
import { MediaOwnerError } from './media-errors.js';

export { MAX_GIF_BYTES, MAX_GIF_DECODE_PIXELS, MAX_GIF_FRAMES } from '../../../utils/gif-image.js';

/** A card may suppress motion without changing the original download or its format identity. */
export async function gifFirstFrame(bytes: Buffer) {
  await inspectGifImage(bytes);
  return sharp(bytes, { page: 0, pages: 1, limitInputPixels: MAX_GIF_DECODE_PIXELS, failOn: 'error' })
    .timeout({ seconds: 5 })
    .resize(768, 768, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

export async function inspectGifImage(bytes: Buffer): Promise<Extract<ImmutableMedia, { kind: 'image' }>> {
  try {
    return await probeGifImage(bytes);
  } catch {
    throw new MediaOwnerError('invalid_media');
  }
}

/** Complete coalesced frames, including GIF transparency/disposal. Source bytes are never replaced. */
export async function gifFrameAtlas(bytes: Buffer) {
  const media = await inspectGifImage(bytes);
  const frameCount = media.animation!.frameCount;
  const { columns, rows } = gifAtlasLayout(media.width, media.height, frameCount);
  const { data, info } = await sharp(bytes, {
    animated: true,
    limitInputPixels: MAX_GIF_DECODE_PIXELS,
    failOn: 'error',
  })
    .timeout({ seconds: 5 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const atlasWidth = media.width * columns,
    atlasHeight = media.height * rows;
  if (atlasWidth > 32768 || atlasHeight > 32768) throw new MediaOwnerError('invalid_media');
  const atlas = Buffer.alloc(atlasWidth * atlasHeight * 4);
  const rowBytes = media.width * 4;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let y = 0; y < media.height; y++) {
      const from = (frame * media.height + y) * rowBytes;
      const to = ((Math.floor(frame / columns) * media.height + y) * atlasWidth + (frame % columns) * media.width) * 4;
      data.copy(atlas, to, from, from + rowBytes);
    }
  }
  if (info.width !== media.width || info.height !== media.height * frameCount)
    throw new MediaOwnerError('invalid_media');
  return sharp(atlas, { raw: { width: atlasWidth, height: atlasHeight, channels: 4 } })
    .png()
    .toBuffer();
}
