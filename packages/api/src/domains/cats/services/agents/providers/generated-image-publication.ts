import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { RichMediaGalleryBlock } from '@cat-cafe/shared';
import {
  copyImageFileToUploadDir,
  mimeToImageExt,
  type SavedImageAsset,
  type SupportedImageMime,
  sanitizeFilenameStem,
} from '../../../../../utils/image-storage.js';
import { getDefaultUploadDir } from '../../../../../utils/upload-paths.js';

export interface GeneratedImagePublicationInput {
  sourcePath: string;
  mimeType: SupportedImageMime;
  publicationKey: string;
  provider: 'codex' | 'antigravity' | 'skill';
  toolName: string;
  prompt?: string;
  uploadDir?: string;
  title?: string;
  alt?: string;
}

export interface GeneratedImagePublicationProvenance {
  provider: string;
  toolName: string;
  prompt?: string;
  originalPath: string;
  publishedPath: string;
  publicationKey: string;
}

export interface PublishedGeneratedImage extends SavedImageAsset {
  mimeType: string;
  originalPath: string;
  publicationKey: string;
  richBlock: RichMediaGalleryBlock;
  provenance: GeneratedImagePublicationProvenance;
  isNew: boolean;
}

export async function publishGeneratedImage(input: GeneratedImagePublicationInput): Promise<PublishedGeneratedImage> {
  const resolvedUploadDir = getDefaultUploadDir(input.uploadDir ?? process.env.UPLOAD_DIR);
  const publicationStem = buildPublicationStem(input.publicationKey);

  const expectedFilename = `${sanitizeFilenameStem(publicationStem)}${mimeToImageExt(input.mimeType)}`;
  let isNew = true;
  try {
    await access(join(resolvedUploadDir, expectedFilename));
    isNew = false;
  } catch {
    /* not yet published */
  }

  const stored = await copyImageFileToUploadDir({
    sourcePath: input.sourcePath,
    mimeType: input.mimeType,
    uploadDir: resolvedUploadDir,
    filenameStem: publicationStem,
    onExists: 'reuse',
  });

  const provenance: GeneratedImagePublicationProvenance = {
    provider: input.provider,
    toolName: input.toolName,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    originalPath: input.sourcePath,
    publishedPath: stored.urlPath,
    publicationKey: input.publicationKey,
  };

  return {
    ...stored,
    isNew,
    mimeType: input.mimeType,
    originalPath: input.sourcePath,
    publicationKey: input.publicationKey,
    richBlock: {
      id: `generated-image-${publicationStem}`,
      kind: 'media_gallery',
      v: 1,
      ...(input.title ? { title: input.title } : {}),
      items: [{ url: stored.urlPath, ...(input.alt ? { alt: input.alt } : {}) }],
      provenance,
    } as RichMediaGalleryBlock,
    provenance,
  };
}

function buildPublicationStem(publicationKey: string): string {
  const sanitized = sanitizeFilenameStem(publicationKey);
  const stableSuffix = createHash('sha256').update(publicationKey).digest('hex').slice(0, 8);
  return sanitizeFilenameStem(`${sanitized}-${stableSuffix}`);
}
