import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { RichMediaGalleryBlock } from '@cat-cafe/shared';
import { detectImageMime } from '../../../../../utils/image-mime.js';
import {
  ALLOWED_IMAGE_MIME_LIST,
  ImagePublicationConflictError,
  mimeToImageExt,
  readImageFile,
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
  const bytes = await readPublicationBytes(input, resolvedUploadDir);
  if (
    input.nativeOrigin &&
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== input.nativeOrigin.blobDigest
  )
    throw new Error('Published image bytes do not match their native generation');
  const mimeType = detectImageMime(bytes);
  if (!mimeType) throw new Error('Unsupported or unsafe generated image content');

  const expectedFilename = `${sanitizeFilenameStem(publicationStem)}${mimeToImageExt(mimeType)}`;
  let isNew = true;
  try {
    await access(join(resolvedUploadDir, expectedFilename));
    isNew = false;
  } catch {
    /* not yet published */
  }

  const stored = await saveImageBufferToUploadDir({
    buffer: bytes,
    mimeType,
    uploadDir: resolvedUploadDir,
    filenameStem: publicationStem,
    onExists: 'verify',
  });
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
    mimeType,
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

/** Source cleanup must not erase an already-published result, including a corrected extension. */
async function readPublicationBytes(input: GeneratedImagePublicationInput, uploadDir: string): Promise<Buffer> {
  if (input.memberBytes) return input.memberBytes;
  try {
    return await readImageFile(input.sourcePath);
  } catch (sourceError) {
    if (!isMissingFile(sourceError)) throw sourceError;
    const published = await recoverPublishedImageBytes(input.publicationKey, uploadDir);
    if (!published) throw sourceError;
    return published;
  }
}

async function recoverPublishedImageBytes(publicationKey: string, uploadDir: string): Promise<Buffer | undefined> {
  let published: Buffer | undefined;
  for (const mimeType of ALLOWED_IMAGE_MIME_LIST) {
    try {
      const candidate = await readImageFile(
        generatedImagePublicationLocation(publicationKey, mimeType, uploadDir).absPath,
      );
      if (published && !published.equals(candidate))
        throw new ImagePublicationConflictError('Publication key already names different image bytes');
      published = candidate;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return published;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
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
