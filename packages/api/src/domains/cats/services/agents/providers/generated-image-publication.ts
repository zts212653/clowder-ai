import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RichMediaGalleryBlock } from '@cat-cafe/shared';
import {
  copyImageFileToUploadDir,
  MAX_IMAGE_FILE_SIZE,
  mimeToImageExt,
  type SavedImageAsset,
  type SupportedImageMime,
  sanitizeFilenameStem,
  saveImageBufferToUploadDir,
} from '../../../../../utils/image-storage.js';
import { getDefaultUploadDir } from '../../../../../utils/upload-paths.js';
import type { CodexNativeImageOrigin } from './codex-native-image-origin.js';

export interface GeneratedImagePublicationInput {
  sourcePath: string;
  mimeType: SupportedImageMime;
  publicationKey: string;
  provider: 'codex' | 'antigravity' | 'skill' | 'member';
  /** Already-authorized member bytes. sourcePath remains client-reported metadata, never opened. */
  memberBytes?: Buffer;
  toolName: string;
  prompt?: string;
  uploadDir?: string;
  title?: string;
  alt?: string;
  nativeOrigin?: CodexNativeImageOrigin;
}

export interface GeneratedImagePublicationProvenance {
  provider: string;
  toolName: string;
  prompt?: string;
  originalPath: string;
  publishedPath: string;
  publicationKey: string;
  nativeOrigin?: CodexNativeImageOrigin;
  sourceKind?: 'member-local';
  sourcePathTrust?: 'client-reported';
  blobDigest?: string;
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
  assertMemberSource(input);
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

  const stored = input.memberBytes
    ? await saveImageBufferToUploadDir({
        buffer: input.memberBytes,
        mimeType: input.mimeType,
        uploadDir: resolvedUploadDir,
        filenameStem: publicationStem,
        onExists: 'verify',
      })
    : await copyImageFileToUploadDir({
        sourcePath: input.sourcePath,
        mimeType: input.mimeType,
        uploadDir: resolvedUploadDir,
        filenameStem: publicationStem,
        onExists: 'reuse',
      });
  if (
    input.nativeOrigin &&
    ((await stat(stored.absPath)).size > MAX_IMAGE_FILE_SIZE ||
      `sha256:${createHash('sha256')
        .update(await readFile(stored.absPath))
        .digest('hex')}` !== input.nativeOrigin.blobDigest)
  )
    throw new Error('Published image bytes do not match their native generation');

  const provenance: GeneratedImagePublicationProvenance = {
    provider: input.provider,
    toolName: input.toolName,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    originalPath: input.sourcePath,
    publishedPath: stored.urlPath,
    publicationKey: input.publicationKey,
    ...(input.nativeOrigin ? { nativeOrigin: input.nativeOrigin } : {}),
    ...(input.memberBytes
      ? {
          sourceKind: 'member-local' as const,
          sourcePathTrust: 'client-reported' as const,
          blobDigest: `sha256:${createHash('sha256').update(input.memberBytes).digest('hex')}`,
        }
      : {}),
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

function assertMemberSource(input: GeneratedImagePublicationInput): void {
  if (input.memberBytes && (input.provider !== 'member' || input.nativeOrigin))
    throw new Error('Member image bytes cannot claim native generation');
  if (input.provider === 'member' && !input.memberBytes)
    throw new Error('Member publication requires authorized bytes');
}

export function generatedImagePublicationLocation(
  publicationKey: string,
  mimeType: SupportedImageMime,
  uploadDir?: string,
) {
  const directory = getDefaultUploadDir(uploadDir ?? process.env.UPLOAD_DIR);
  const filename = `${sanitizeFilenameStem(buildPublicationStem(publicationKey))}${mimeToImageExt(mimeType)}`;
  return { absPath: join(directory, filename), urlPath: `/uploads/${filename}` as const };
}

function buildPublicationStem(publicationKey: string): string {
  const sanitized = sanitizeFilenameStem(publicationKey);
  const stableSuffix = createHash('sha256').update(publicationKey).digest('hex').slice(0, 8);
  return sanitizeFilenameStem(`${sanitized}-${stableSuffix}`);
}
