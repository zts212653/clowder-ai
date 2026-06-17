/**
 * Memory-bounded workspace file reading (F063 OOM fix).
 *
 * The Workspace file-preview path used to `readFile(path, 'utf-8')` on the whole
 * file and then hash the entire content. Opening a large file — or a video whose
 * extension wasn't in the MIME whitelist (so it was treated as text) — pulled
 * hundreds of MB into a single JS string and flattened it for hashing, blowing
 * the V8 heap (OOM, process abort). The file-watcher had the same unguarded read
 * and re-ran it on every poll.
 *
 * Both the route and the watcher now go through these helpers, which:
 *  - never read more than `maxBytes` into memory, regardless of real file size;
 *  - classify binary files IDENTICALLY — first by extension/MIME (known media),
 *    then by content (NUL byte) — so the route and the watcher never disagree;
 *  - return an empty sha256 for binary/oversized files so the route and watcher
 *    agree (otherwise small media files would spuriously report "externally
 *    changed" because one side hashed them and the other didn't).
 */

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';

/** Hard cap on bytes read into memory for a text preview / hash. */
export const MAX_PREVIEW_BYTES = 1024 * 1024; // 1 MB

const MIME_MAP: Record<string, string> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/tsx',
  '.js': 'text/javascript',
  '.jsx': 'text/jsx',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/** Guess a MIME type from a file extension; 'text/plain' when unknown. */
export function guessMime(filepath: string): string {
  return MIME_MAP[extname(filepath)] ?? 'text/plain';
}

function isMediaMime(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/');
}

/**
 * True when the file's extension maps to a media (image/audio/video) MIME type.
 * This is the SHARED known-binary predicate — both the route and the watcher
 * must use it so they classify the same file the same way.
 */
export function isKnownBinaryPath(absPath: string): boolean {
  return isMediaMime(guessMime(absPath));
}

export interface WorkspaceFilePreview {
  /** Decoded text content, bounded to `maxBytes`. Empty for binary files. */
  content: string;
  /**
   * sha256 of the content for fully-read text files; `''` for binary or
   * truncated files. The empty value keeps the route and the file-watcher in
   * sync so large/binary files don't spuriously report "externally changed".
   */
  sha256: string;
  /** Real file size in bytes (from stat, not the bounded read). */
  size: number;
  /** True when `size` exceeds `maxBytes` (content is a bounded prefix). */
  truncated: boolean;
  /** True when the file is detected as binary (known media MIME or NUL bytes). */
  binary: boolean;
  /** Guessed MIME type from the file extension ('text/plain' when unknown). */
  mime: string;
}

function hashUtf8(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Read at most `byteCount` bytes from the start of a file. Never loads more
 * than `byteCount` into memory regardless of the real file size — this is the
 * core OOM guard.
 */
async function readPrefix(absPath: string, byteCount: number): Promise<Buffer> {
  if (byteCount <= 0) return Buffer.alloc(0);
  const handle = await open(absPath, 'r');
  try {
    const buf = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buf, 0, byteCount, 0);
    return bytesRead === byteCount ? buf : buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Heuristic binary sniff: a NUL byte in the inspected prefix means binary. This
 * is the same rule git uses and reliably catches video/image/audio/compiled
 * blobs even when the file extension is unknown.
 */
function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

/**
 * Memory-bounded preview of a workspace file. Reads at most `maxBytes`, so it can
 * never OOM on a large file or a mis-detected binary (e.g. a video with an
 * unrecognized extension). Binary classification matches {@link isKnownBinaryPath}
 * + a NUL-byte content sniff, identical to the watcher's signature logic.
 */
export async function readWorkspaceFilePreview(
  absPath: string,
  opts: { maxBytes?: number } = {},
): Promise<WorkspaceFilePreview> {
  const maxBytes = opts.maxBytes ?? MAX_PREVIEW_BYTES;
  const { size } = await stat(absPath);
  const mime = guessMime(absPath);

  if (isMediaMime(mime)) {
    return { content: '', sha256: '', size, truncated: false, binary: true, mime };
  }

  const truncated = size > maxBytes;
  const prefix = await readPrefix(absPath, Math.min(size, maxBytes));

  if (looksBinary(prefix)) {
    return { content: '', sha256: '', size, truncated: false, binary: true, mime };
  }

  const content = prefix.toString('utf-8');
  return {
    content,
    sha256: truncated ? '' : hashUtf8(content),
    size,
    truncated,
    binary: false,
    mime,
  };
}

/**
 * Change-detection signature for the file-watcher. Returns:
 *  - the full-content sha256 for small text files,
 *  - `''` for known-media, binary, or oversized files (not tracked — they
 *    aren't editable),
 *  - `null` on read error (caller treats as "no signature").
 *
 * Uses the SAME binary predicate as {@link readWorkspaceFilePreview} (known-media
 * extension first, then NUL-byte sniff), so the route and the watcher always
 * agree on a file's hash and small media files don't fire spurious change events.
 * Bounded the same way too, so the watcher can never OOM on a watched large file
 * even though it polls every second.
 */
export async function computeWorkspaceFileSha256(
  absPath: string,
  maxBytes = MAX_PREVIEW_BYTES,
): Promise<string | null> {
  try {
    const { size } = await stat(absPath);
    if (size > maxBytes) return '';
    if (isKnownBinaryPath(absPath)) return '';
    const prefix = await readPrefix(absPath, Math.min(size, maxBytes));
    if (looksBinary(prefix)) return '';
    return hashUtf8(prefix.toString('utf-8'));
  } catch {
    return null;
  }
}
