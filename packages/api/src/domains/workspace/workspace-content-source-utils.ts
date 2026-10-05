import { createHash } from 'node:crypto';
import { type FileHandle, realpath, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { normalizeWorkspaceRelativePath } from '@cat-cafe/shared/utils';
import {
  type WorkspaceContentDescriptionV1,
  type WorkspaceContentLocatorV1,
  WorkspaceContentSourceError,
} from './workspace-content-source-contract.js';
import { resolveWorkspaceFilesystemPath, WorkspaceSecurityError } from './workspace-security.js';

const READ_CHUNK_BYTES = 256 * 1024;

export function classifyWorkspaceContentMime(mime: string): WorkspaceContentDescriptionV1['kind'] {
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/json') return 'text';
  if (mime.startsWith('image/') || mime.startsWith('video/')) return 'media';
  return 'unsupported';
}

export function supportedWorkspaceMediaMime(description: WorkspaceContentDescriptionV1): 'image/png' | 'video/mp4' {
  if (description.kind !== 'media' || (description.mime !== 'image/png' && description.mime !== 'video/mp4'))
    throw new WorkspaceContentSourceError('unsupported_media');
  return description.mime;
}

export function validateWorkspaceContentLocator(locator: WorkspaceContentLocatorV1): WorkspaceContentLocatorV1 {
  if (
    !locator ||
    typeof locator.worktreeId !== 'string' ||
    typeof locator.path !== 'string' ||
    locator.worktreeId.length === 0 ||
    locator.worktreeId.length > 256 ||
    locator.path.length === 0 ||
    locator.path.length > 2048 ||
    locator.worktreeId.trim() !== locator.worktreeId ||
    locator.path.includes('\0')
  ) {
    throw new WorkspaceContentSourceError('access_denied');
  }
  try {
    const path = normalizeWorkspaceRelativePath(locator.path);
    if (!path || path === '.' || path.startsWith('../')) throw new Error('invalid relative path');
    return { worktreeId: locator.worktreeId, path };
  } catch {
    throw new WorkspaceContentSourceError('access_denied');
  }
}

export interface CanonicalWorkspaceContentLocator {
  readonly path: string;
  readonly locator: WorkspaceContentLocatorV1;
}

/** Owner identity is based on the resolved object, not caller path spelling. */
export async function canonicalizeWorkspaceContentLocator(
  root: string,
  locator: WorkspaceContentLocatorV1,
): Promise<CanonicalWorkspaceContentLocator> {
  const checked = validateWorkspaceContentLocator(locator);
  const lexical = await resolveWorkspaceFilesystemPath(root, checked.path);
  const path = await realpath(lexical);
  const canonicalPath = canonicalWorkspaceRelativePath(root, path);
  return { path, locator: { ...checked, path: canonicalPath } };
}

/** Prove post-open that the named in-root target still is the opened inode. */
export async function openedWorkspaceContentMatchesCanonicalLocator(
  root: string,
  path: string,
  locator: WorkspaceContentLocatorV1,
  handle: FileHandle,
): Promise<boolean> {
  const [resolved, named, opened] = await Promise.all([realpath(path), stat(path), handle.stat()]);
  return (
    canonicalWorkspaceRelativePath(root, resolved) === locator.path &&
    named.dev === opened.dev &&
    named.ino === opened.ino
  );
}

function canonicalWorkspaceRelativePath(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === '.' || value === '..' || value.startsWith(`..${sep}`) || value.includes('\0')) {
    throw new WorkspaceSecurityError('Canonical path outside workspace root', 'TRAVERSAL');
  }
  return validateWorkspaceContentLocator({ worktreeId: 'canonical', path: value.split(sep).join('/') }).path;
}

export function validateWorkspaceQuote(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8000 || value.includes('\0')) {
    throw new WorkspaceContentSourceError('access_denied');
  }
  return value;
}

export async function digestWorkspaceFile(
  handle: FileHandle,
  size: number,
  collectBytes: boolean,
): Promise<{ digest: `sha256:${string}`; byteLength: number; bytes?: Buffer }> {
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let position = 0;
  while (position < size) {
    const length = Math.min(READ_CHUNK_BYTES, size - position);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) break;
    const chunk = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (collectBytes) chunks.push(chunk);
    position += bytesRead;
  }
  return {
    digest: `sha256:${hash.digest('hex')}`,
    byteLength: position,
    ...(collectBytes ? { bytes: Buffer.concat(chunks, position) } : {}),
  };
}

export function hasSameWorkspaceFileState(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function workspaceContentRef(ownerUserId: string, root: string, path: string): `workspace-content:${string}` {
  return `workspace-content:${createHash('sha256')
    .update(JSON.stringify([ownerUserId, root, path]))
    .digest('hex')}`;
}

export function workspaceTextDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function decodeWorkspaceText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new WorkspaceContentSourceError('unsupported_text');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkspaceContentSourceError('unsupported_text');
  }
}
