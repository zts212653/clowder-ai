import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ImageContent } from '@cat-cafe/shared';

export const ALLOWED_IMAGE_MIME_LIST = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
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
  onExists?: OnExistsBehavior;
}): Promise<SavedImageAsset> {
  const mimeType = ensureSupportedImageMime(input.mimeType);
  if (input.buffer.byteLength > MAX_IMAGE_FILE_SIZE) {
    throw new ImageUploadError(`File too large: ${input.buffer.byteLength} bytes (max ${MAX_IMAGE_FILE_SIZE})`);
  }

  const target = await ensureImageTarget(input.uploadDir, mimeType, input.filenameStem);
  const onExists = input.onExists ?? 'reuse';
  try {
    await writeFile(target.absPath, input.buffer, { flag: 'wx' });
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    return handleExistingTarget(target, onExists);
  }
  return target;
}

export async function copyImageFileToUploadDir(input: {
  sourcePath: string;
  mimeType: string;
  uploadDir: string;
  filenameStem: string;
  onExists?: OnExistsBehavior;
}): Promise<SavedImageAsset> {
  const mimeType = ensureSupportedImageMime(input.mimeType);

  const target = await ensureImageTarget(input.uploadDir, mimeType, input.filenameStem);
  const onExists = input.onExists ?? 'reuse';
  if (onExists === 'reuse') {
    try {
      await access(target.absPath);
      return target;
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
  }

  const sourceStats = await stat(input.sourcePath);
  if (sourceStats.size > MAX_IMAGE_FILE_SIZE) {
    throw new ImageUploadError(`File too large: ${sourceStats.size} bytes (max ${MAX_IMAGE_FILE_SIZE})`);
  }
  if (resolve(input.sourcePath) === target.absPath) {
    await access(target.absPath);
    return handleExistingTarget(target, onExists);
  }

  try {
    await copyFile(input.sourcePath, target.absPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    return handleExistingTarget(target, onExists);
  }
  return target;
}
