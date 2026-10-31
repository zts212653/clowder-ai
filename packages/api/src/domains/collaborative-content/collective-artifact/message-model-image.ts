import type { Readable } from 'node:stream';
import {
  COLLECTIVE_MODEL_IMAGE_MAX_BYTES,
  type CollectiveMessageAttachment,
  type CollectiveModelImage,
} from '@cat-cafe/shared';
import sharp, { type Metadata } from 'sharp';

const IMAGE_MIME_BY_FORMAT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

async function readOriginalBytes(body: Readable, expectedLength: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > expectedLength) throw new Error('Attachment length changed');
    chunks.push(Buffer.from(chunk));
  }
  if (size !== expectedLength) throw new Error('Attachment read was incomplete');
  return Buffer.concat(chunks, size);
}

function unchangedImageType(metadata: Metadata, size: number): CollectiveModelImage['mediaType'] | undefined {
  if (
    size > COLLECTIVE_MODEL_IMAGE_MAX_BYTES ||
    !metadata.width ||
    !metadata.height ||
    metadata.width > 1536 ||
    metadata.height > 1536 ||
    (metadata.orientation !== undefined && metadata.orientation !== 1) ||
    (metadata.pages !== undefined && metadata.pages !== 1)
  )
    return;
  const mime = IMAGE_MIME_BY_FORMAT[metadata.format ?? ''];
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp') return mime;
}

/** Derives a bounded first-frame view; the original remains in its immutable byte owner. */
export async function readCollectiveModelImage(
  attachment: CollectiveMessageAttachment,
  body: Readable,
  authorize: () => Promise<void>,
): Promise<CollectiveModelImage> {
  try {
    const bytes = await readOriginalBytes(body, attachment.byteLength);
    await authorize();
    const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' });
    const metadata = await decoder.metadata();
    const mime = IMAGE_MIME_BY_FORMAT[metadata.format ?? ''];
    if (!mime || mime !== attachment.mediaType || !metadata.width || !metadata.height)
      throw new Error('Attachment is not a supported image of its declared type');
    const original = {
      attachmentId: attachment.attachmentId,
      sourceDigest: attachment.blobDigest,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
    };
    const unchangedType = unchangedImageType(metadata, bytes.length);
    if (unchangedType) {
      // Reading headers alone cannot establish that the uploaded bytes contain decodable pixels.
      await decoder.stats();
      await authorize();
      return {
        kind: 'collective_model_image',
        v: 1,
        ...original,
        mediaType: unchangedType,
        dataBase64: bytes.toString('base64'),
        width: metadata.width,
        height: metadata.height,
        transformed: false,
      };
    }
    let edge = 1536;
    for (;;) {
      await authorize();
      const result = await decoder
        .clone()
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      await authorize();
      if (result.data.byteLength <= COLLECTIVE_MODEL_IMAGE_MAX_BYTES)
        return {
          kind: 'collective_model_image',
          v: 1,
          ...original,
          mediaType: 'image/jpeg',
          dataBase64: result.data.toString('base64'),
          width: result.info.width,
          height: result.info.height,
          transformed: true,
        };
      if (edge <= 192) throw new Error('Image cannot fit the native model response');
      edge = Math.floor(edge * 0.75);
    }
  } finally {
    body.destroy();
  }
}
