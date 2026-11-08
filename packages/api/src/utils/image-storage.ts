import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ImageContent } from '@cat-cafe/shared';
import { probeGifImage } from './gif-image.js';
import { detectImageMime } from './image-mime.js';
import { probeSvgImage } from './svg-image.js';

export const ALLOWED_IMAGE_MIME_LIST = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const;
export type SupportedImageMime = (typeof ALLOWED_IMAGE_MIME_LIST)[number];
export const ALLOWED_IMAGE_MIMES: ReadonlySet<SupportedImageMime> = new Set(ALLOWED_IMAGE_MIME_LIST);
export const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILENAME_STEM_LENGTH = 240;

export interface SavedImageAsset {
  absPath: string;
  urlPath: `/uploads/${string}`;
  content: ImageContent;
}

export type OnExistsBehavior = 'reuse' | 'error';

export class ImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageUploadError';
  }
}

export class ImagePublicationConflictError extends ImageUploadError {}

export function isAllowedImageMime(mimeType: string): mimeType is SupportedImageMime {
  return (ALLOWED_IMAGE_MIMES as ReadonlySet<string>).has(mimeType);
}

export function mimeToImageExt(mimeType: SupportedImageMime): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    default:
      throw new ImageUploadError(`Unsupported file type: ${String(mimeType)}`);
  }
}

export function sanitizeFilenameStem(filenameStem: string): string {
  const normalized = filenameStem
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-');
  const sanitized = normalized.replace(/^[.-]+|[.-]+$/g, '');
  const stableSuffix = createHash('sha256').update(filenameStem).digest('hex').slice(0, 8);
  if (sanitized.length > MAX_FILENAME_STEM_LENGTH) {
    return `${sanitized.slice(0, MAX_FILENAME_STEM_LENGTH - stableSuffix.length - 1)}-${stableSuffix}`;
  }
  if (sanitized) return sanitized;
  return `image-${stableSuffix}`;
}

function buildSavedImage(uploadDir: string, filename: string): SavedImageAsset {
  const absPath = resolve(join(uploadDir, filename));
  const urlPath = `/uploads/${filename}` as const;
  return {
    absPath,
    urlPath,
    content: { type: 'image', url: urlPath },
  };
}

function ensureSupportedImageMime(mimeType: string): SupportedImageMime {
  if (!isAllowedImageMime(mimeType)) {
    throw new ImageUploadError(`Unsupported file type: ${mimeType}`);
  }
  return mimeType;
}

async function ensureImageTarget(uploadDir: string, mimeType: SupportedImageMime, filenameStem: string) {
  await mkdir(uploadDir, { recursive: true });
  const filename = `${sanitizeFilenameStem(filenameStem)}${mimeToImageExt(mimeType)}`;
  return buildSavedImage(uploadDir, filename);
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function handleExistingTarget(target: SavedImageAsset, onExists: OnExistsBehavior): SavedImageAsset {
  if (onExists === 'reuse') return target;
  throw new ImageUploadError(`Target image already exists: ${target.absPath}`);
}

export async function saveImageBufferToUploadDir(input: {
  buffer: Buffer;
  mimeType: string;
  uploadDir: string;
  filenameStem: string;
  onExists?: OnExistsBehavior | 'verify';
}): Promise<SavedImageAsset> {
  ensureSupportedImageMime(input.mimeType);
  if (input.buffer.byteLength > MAX_IMAGE_FILE_SIZE) {
    throw new ImageUploadError(`File too large: ${input.buffer.byteLength} bytes (max ${MAX_IMAGE_FILE_SIZE})`);
  }
  const mimeType = detectImageMime(input.buffer);
  if (!mimeType) throw new ImageUploadError('Unsafe or unsupported image content');
  if (mimeType === 'image/svg+xml' || mimeType === 'image/gif') {
    try {
      if (mimeType === 'image/gif') await probeGifImage(input.buffer);
      else await probeSvgImage(input.buffer);
    } catch {
      throw new ImageUploadError(`Unsafe or unsupported ${mimeType === 'image/gif' ? 'GIF' : 'SVG'}`);
    }
  }

  const target = await ensureImageTarget(input.uploadDir, mimeType, input.filenameStem);
  const onExists = input.onExists ?? 'reuse';
  if (onExists === 'verify') return saveImmutableImageBuffer(target, input.buffer);
  try {
    await writeFile(target.absPath, input.buffer, { flag: 'wx' });
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    return handleExistingTarget(target, onExists);
  }
  return target;
}

/** Publish a complete immutable file; concurrent writers compare the winner, never a partial write. */
async function saveImmutableImageBuffer(target: SavedImageAsset, bytes: Buffer): Promise<SavedImageAsset> {
  const temporary = join(dirname(target.absPath), `.image-publication-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    try {
      await link(temporary, target.absPath);
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      await assertPublishedImageBytes(target.absPath, bytes);
    }
    return target;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isFileNotFoundError(error)) throw error;
    });
  }
}

async function assertPublishedImageBytes(path: string, bytes: Buffer): Promise<void> {
  const existing = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await existing.stat();
    if (!info.isFile() || info.size !== bytes.length)
      throw new ImagePublicationConflictError('Publication key already names different image bytes');
    const actual = Buffer.alloc(bytes.length + 1);
    let length = 0;
    while (length < actual.length) {
      const { bytesRead } = await existing.read(actual, length, actual.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!actual.subarray(0, length).equals(bytes))
      throw new ImagePublicationConflictError('Publication key already names different image bytes');
  } finally {
    await existing.close();
  }
}

export async function copyImageFileToUploadDir(input: {
  sourcePath: string;
  mimeType: string;
  uploadDir: string;
  filenameStem: string;
  onExists?: OnExistsBehavior;
}): Promise<SavedImageAsset> {
  let bytes: Buffer;
  try {
    bytes = await readImageFile(input.sourcePath);
  } catch (error) {
    if ((input.onExists ?? 'reuse') !== 'reuse' || !isFileNotFoundError(error)) throw error;
    // An already published original remains recoverable after its temporary generation source is removed.
    const mime = ensureSupportedImageMime(input.mimeType);
    const target = await ensureImageTarget(input.uploadDir, mime, input.filenameStem);
    bytes = await readImageFile(target.absPath);
  }
  return saveImageBufferToUploadDir({
    buffer: bytes,
    mimeType: input.mimeType,
    uploadDir: input.uploadDir,
    filenameStem: input.filenameStem,
    onExists: input.onExists,
  });
}

/** A bounded snapshot closes before publication; a renamed/relabelled source cannot alter the bytes being saved. */
export async function readImageFile(path: string): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ImageUploadError('Image must be a regular file');
    if (info.size > MAX_IMAGE_FILE_SIZE)
      throw new ImageUploadError(`File too large: ${info.size} bytes (max ${MAX_IMAGE_FILE_SIZE})`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_IMAGE_FILE_SIZE)
        throw new ImageUploadError(`File too large: ${size} bytes (max ${MAX_IMAGE_FILE_SIZE})`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}
