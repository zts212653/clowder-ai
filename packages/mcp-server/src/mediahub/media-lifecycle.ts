/**
 * MediaHub — Media Lifecycle
 * F139 Phase C: File validation, mime detection, and size limits.
 *
 * Enforces gpt52 review requirements:
 * - Pre-send file type/size validation
 * - Supported media type whitelist
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAGIC_READ_BYTES = 12;

export interface MediaValidation {
  valid: boolean;
  mimeType: string;
  fileSize: number;
  error?: string;
}

export interface CleanupResult {
  deleted: number;
  errors: string[];
}

/** Magic byte signatures keyed by mime type */
const MAGIC_CHECKS: Record<string, (buf: Buffer) => boolean> = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  'image/webp': (b) =>
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50,
  'video/mp4': (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70, // ftyp
  'video/quicktime': (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  'video/webm': (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3, // EBML
};

function checkMagicBytes(filePath: string, expectedMime: string): boolean {
  const check = MAGIC_CHECKS[expectedMime];
  if (!check) return true; // no signature registered — allow
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(MAGIC_READ_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, MAGIC_READ_BYTES, 0);
    if (bytesRead < MAGIC_READ_BYTES) return false;
    return check(buf);
  } finally {
    fs.closeSync(fd);
  }
}

const EXT_TO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] ?? 'application/octet-stream';
}

export function isVideoType(mime: string): boolean {
  return VIDEO_TYPES.has(mime);
}

export function isImageType(mime: string): boolean {
  return IMAGE_TYPES.has(mime);
}

/** Validate a local media file for type and size limits */
export function validateMediaFile(filePath: string): MediaValidation {
  if (!fs.existsSync(filePath)) {
    return { valid: false, mimeType: '', fileSize: 0, error: 'File not found' };
  }

  const stats = fs.statSync(filePath);
  const mimeType = guessMimeType(filePath);
  const fileSize = stats.size;

  if (!VIDEO_TYPES.has(mimeType) && !IMAGE_TYPES.has(mimeType)) {
    return { valid: false, mimeType, fileSize, error: `Unsupported media type: ${mimeType}` };
  }

  const maxBytes = VIDEO_TYPES.has(mimeType) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (fileSize > maxBytes) {
    const maxMB = Math.round(maxBytes / (1024 * 1024));
    const fileMB = Math.round(fileSize / (1024 * 1024));
    return { valid: false, mimeType, fileSize, error: `File too large: ${fileMB}MB > ${maxMB}MB limit` };
  }

  // Magic byte validation — ensure file content matches extension
  if (!checkMagicBytes(filePath, mimeType)) {
    return { valid: false, mimeType, fileSize, error: `Content mismatch: file magic bytes don't match ${mimeType}` };
  }

  return { valid: true, mimeType, fileSize };
}

/** Remove local media files whose jobs have expired from Redis */
export async function cleanupExpiredMedia(
  baseDir: string,
  jobExists: (jobId: string) => Promise<boolean>,
): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: [] };
  if (!fs.existsSync(baseDir)) return result;

  const providerDirs = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const providerDir of providerDirs) {
    const providerPath = path.join(baseDir, providerDir.name);
    const jobDirs = fs.readdirSync(providerPath, { withFileTypes: true }).filter((d) => d.isDirectory());

    for (const jobDir of jobDirs) {
      try {
        const exists = await jobExists(jobDir.name);
        if (!exists) {
          fs.rmSync(path.join(providerPath, jobDir.name), { recursive: true });
          result.deleted++;
        }
      } catch (err) {
        result.errors.push(`${jobDir.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}
