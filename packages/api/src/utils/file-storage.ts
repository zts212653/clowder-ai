import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { FileContent } from '@cat-cafe/shared';
import { ImageUploadError, sanitizeFilenameStem } from './image-storage.js';

export { ImageUploadError as FileUploadError } from './image-storage.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const ALLOWED_FILE_MIME_LIST = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'application/yaml',
  'text/yaml',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/octet-stream',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
] as const;

export type SupportedFileMime = (typeof ALLOWED_FILE_MIME_LIST)[number];
export const ALLOWED_FILE_MIMES: ReadonlySet<string> = new Set(ALLOWED_FILE_MIME_LIST);
export const MAX_FILE_UPLOAD_SIZE = MAX_FILE_SIZE;

export interface SavedFileAsset {
  absPath: string;
  urlPath: `/uploads/${string}`;
  content: FileContent;
}

export function isAllowedFileMime(mimeType: string): boolean {
  return ALLOWED_FILE_MIMES.has(mimeType);
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

export function isImageFile(mimeType: string): boolean {
  return isImageMime(mimeType);
}

function mimeToDefaultExt(mimeType: string): string {
  const map: Record<string, string> = {
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'text/html': '.html',
    'text/css': '.css',
    'text/javascript': '.js',
    'application/json': '.json',
    'application/xml': '.xml',
    'application/yaml': '.yaml',
    'text/yaml': '.yaml',
    'application/zip': '.zip',
    'application/x-tar': '.tar',
    'application/gzip': '.gz',
    'application/x-7z-compressed': '.7z',
    'application/x-rar-compressed': '.rar',
    'application/octet-stream': '.bin',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/flac': '.flac',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
  };
  return map[mimeType] ?? '.bin';
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function buildDisplayName(originalFilename: string, mimeType: string): string {
  const ext = extname(originalFilename).toLowerCase() || mimeToDefaultExt(mimeType);
  const stem = basename(originalFilename, extname(originalFilename)) || 'upload';
  const sanitizedStem = stem
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return `${sanitizedStem || 'upload'}${ext}`;
}

export async function saveFileBufferToUploadDir(input: {
  buffer: Buffer;
  mimeType: string;
  originalFilename: string;
  uploadDir: string;
  filenameStem: string;
}): Promise<SavedFileAsset> {
  if (isImageMime(input.mimeType)) {
    throw new ImageUploadError(
      `Image files should use saveImageBufferToUploadDir, not saveFileBufferToUploadDir (got ${input.mimeType})`,
    );
  }
  if (!isAllowedFileMime(input.mimeType)) {
    throw new ImageUploadError(`Unsupported file type: ${input.mimeType}`);
  }
  if (input.buffer.byteLength > MAX_FILE_SIZE) {
    throw new ImageUploadError(`File too large: ${input.buffer.byteLength} bytes (max ${MAX_FILE_SIZE})`);
  }

  await mkdir(input.uploadDir, { recursive: true });
  const ext = extname(input.originalFilename).toLowerCase() || mimeToDefaultExt(input.mimeType);
  const uniqueStem = sanitizeFilenameStem(input.filenameStem);
  const diskFilename = `${uniqueStem}${ext}`;
  const absPath = resolve(join(input.uploadDir, diskFilename));
  const urlPath = `/uploads/${diskFilename}` as const;
  const displayName = buildDisplayName(input.originalFilename, input.mimeType);

  try {
    await writeFile(absPath, input.buffer, { flag: 'wx' });
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    return {
      absPath,
      urlPath,
      content: {
        type: 'file',
        url: urlPath,
        fileName: displayName,
        mimeType: input.mimeType,
        fileSize: input.buffer.byteLength,
      },
    };
  }

  return {
    absPath,
    urlPath,
    content: {
      type: 'file',
      url: urlPath,
      fileName: displayName,
      mimeType: input.mimeType,
      fileSize: input.buffer.byteLength,
    },
  };
}

export interface UploadFileEntry {
  filename?: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
}

export async function saveUploadedFiles(files: UploadFileEntry[], uploadDir: string): Promise<SavedFileAsset[]> {
  const saved: SavedFileAsset[] = [];
  for (const file of files) {
    if (isImageMime(file.mimetype)) continue;
    const buffer = await file.toBuffer();
    saved.push(
      await saveFileBufferToUploadDir({
        buffer,
        mimeType: file.mimetype,
        originalFilename: file.filename ?? `upload-${Date.now()}`,
        uploadDir,
        filenameStem: `${Date.now()}-${randomUUID().slice(0, 8)}`,
      }),
    );
  }
  return saved;
}
