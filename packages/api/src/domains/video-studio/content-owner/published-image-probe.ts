import { type ImmutableMedia, immutableMediaSchema, type ReviewedMediaType } from '@cat-cafe/shared';
import sharp from 'sharp';
import { MediaOwnerError } from './media-errors.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode for admission only. The original bytes, MIME and digest remain the original owner's. */
export async function probeImmutableImage(
  bytes: Buffer,
  mime: Exclude<ReviewedMediaType, 'video/mp4'>,
): Promise<ImmutableMedia> {
  try {
    if (mime === 'image/png' && !bytes.subarray(0, 8).equals(pngSignature)) throw new MediaOwnerError('invalid_media');
    const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== mime.slice(6) ||
      (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation !== undefined &&
        (!Number.isInteger(metadata.orientation) || metadata.orientation < 1 || metadata.orientation > 8)) ||
      // Preserve the original PNG orientation fence. All admitted images use EXIF display coordinates.
      (mime === 'image/png' && metadata.orientation !== undefined && metadata.orientation !== 1)
    )
      throw new MediaOwnerError('invalid_media');
    await decoder.stats();
    return immutableMediaSchema.parse({
      kind: 'image',
      width: metadata.autoOrient.width,
      height: metadata.autoOrient.height,
    });
  } catch {
    throw new MediaOwnerError('invalid_media');
  }
}
