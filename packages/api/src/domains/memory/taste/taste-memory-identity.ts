import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const PUBLIC_TASTE_PREFIX = 'docs/taste/vignettes/';
const PRIVATE_TASTE_PREFIX = 'private/taste/';
const TASTE_FILENAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*\.md$/u;

export function validTasteSourcePath(sourcePath: string): boolean {
  if (!sourcePath || sourcePath.includes('\\') || posix.normalize(sourcePath) !== sourcePath) return false;
  const prefix = sourcePath.startsWith(PUBLIC_TASTE_PREFIX)
    ? PUBLIC_TASTE_PREFIX
    : sourcePath.startsWith(PRIVATE_TASTE_PREFIX)
      ? PRIVATE_TASTE_PREFIX
      : null;
  if (!prefix) return false;
  const filename = sourcePath.slice(prefix.length);
  return !filename.includes('/') && TASTE_FILENAME_RE.test(filename);
}

export function tasteMemoryId(sourcePath: string): string {
  return `taste-${createHash('sha256').update(sourcePath).digest('hex').slice(0, 24)}`;
}

export function tasteSourceAnchor(sourcePath: string): string {
  if (!validTasteSourcePath(sourcePath)) throw new Error(`Invalid Taste source path: ${sourcePath}`);
  return `taste-vignette:${sourcePath}`;
}

export function sourcePathFromTasteAnchor(anchor: string): string | null {
  if (!anchor.startsWith('taste-vignette:')) return null;
  const sourcePath = anchor.slice('taste-vignette:'.length);
  return validTasteSourcePath(sourcePath) ? sourcePath : null;
}

export function tasteDocumentAnchor(sourcePath: string): string {
  if (!validTasteSourcePath(sourcePath)) throw new Error(`Invalid Taste source path: ${sourcePath}`);
  const scannerRelative = sourcePath.startsWith('docs/') ? sourcePath.slice('docs/'.length) : sourcePath;
  return `doc:${scannerRelative.replace(/\.md$/, '')}`;
}
