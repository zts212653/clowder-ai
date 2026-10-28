/**
 * Image Upload Utilities
 * Handles multipart file saving and validation for image uploads.
 */

import { createHash, randomUUID } from 'node:crypto';
import { findMessageStickerByDigest, messageStickerReference } from '@cat-cafe/shared';
import type { SavedImageAsset } from '../utils/image-storage.js';
import { ImageUploadError, saveImageBufferToUploadDir } from '../utils/image-storage.js';

export { ImageUploadError } from '../utils/image-storage.js';

const MAX_FILES = 5;

export type SavedImage = SavedImageAsset;

export interface UploadImageFile {
  filename?: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
}

/**
 * Validate and save uploaded image files.
 * Returns saved image metadata for contentBlocks and CLI passthrough.
 */
export async function saveUploadedImages(files: UploadImageFile[], uploadDir: string): Promise<SavedImage[]> {
  if (files.length > MAX_FILES) {
    throw new ImageUploadError(`Too many files (max ${MAX_FILES})`);
  }

  const saved: SavedImage[] = [];
  for (const file of files) {
    const buffer = await file.toBuffer();
    const image = await saveImageBufferToUploadDir({
      buffer,
      mimeType: file.mimetype,
      uploadDir,
      filenameStem: `${Date.now()}-${randomUUID().slice(0, 8)}`,
      onExists: 'error',
    });
    const sticker =
      file.mimetype === 'image/png'
        ? findMessageStickerByDigest(`sha256:${createHash('sha256').update(buffer).digest('hex')}`)
        : undefined;
    saved.push(
      sticker ? { ...image, content: { ...image.content, sticker: messageStickerReference(sticker.id) } } : image,
    );
  }

  return saved;
}
