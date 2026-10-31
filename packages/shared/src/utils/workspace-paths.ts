import { isAbsolute, win32 } from 'node:path';

/**
 * Accept both host-platform absolute paths and Windows drive/UNC paths.
 * This keeps validation deterministic in tests even when they run on macOS/Linux.
 */
export function isAbsoluteFilesystemPath(input: string): boolean {
  return isAbsolute(input) || win32.isAbsolute(input);
}

/**
 * Workspace APIs use POSIX-style relative paths as their wire format so the
 * frontend can reason about ancestry and basenames consistently on every OS.
 */
export function normalizeWorkspaceRelativePath(input: string): string {
  return input.replaceAll('\\', '/');
}
