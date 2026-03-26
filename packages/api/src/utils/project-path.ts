/**
 * Project Path Validation
 * 共享的路径安全校验，防止路径遍历和 symlink 逃逸。
 *
 * 使用 realpath() 解析 symlink 后再做边界检查。
 * 被 projects.ts, threads.ts, AgentRouter.ts 复用。
 */

import { realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, relative, resolve, win32 } from 'node:path';

/**
 * Allowed root directories for project paths.
 *
 * Default: homedir + /tmp + /private/tmp + /workspace + /Volumes (macOS only).
 *
 * PROJECT_ALLOWED_ROOTS (system path delimiter separated):
 *   - Default behaviour: **replaces** built-in defaults (backward compat).
 *   - Set PROJECT_ALLOWED_ROOTS_APPEND=true to merge with defaults instead.
 */
export function getDefaultRootsForPlatform(
  platformName = platform(),
  opts?: { homeDir?: string; pathExists?: (targetPath: string) => boolean },
): string[] {
  const homeDir = opts?.homeDir ?? homedir();
  const roots = new Set<string>([homeDir]);

  if (platformName === 'win32') {
    return [...roots];
  }

  roots.add('/tmp');
  roots.add('/private/tmp');
  roots.add('/workspace');
  if (platformName === 'darwin') roots.add('/Volumes');
  return [...roots];
}

const defaultRootsCache = new Map<string, string[]>();

const DEFAULT_ROOTS = (): string[] => {
  const platformName = platform();
  const cached = defaultRootsCache.get(platformName);
  if (cached) return cached;
  const roots = getDefaultRootsForPlatform(platformName);
  defaultRootsCache.set(platformName, roots);
  return roots;
};

const ALLOWED_ROOTS = (): string[] => {
  const envRoots = process.env.PROJECT_ALLOWED_ROOTS;
  if (envRoots?.trim()) {
    const custom = envRoots.split(delimiter).filter(Boolean);
    const append = process.env.PROJECT_ALLOWED_ROOTS_APPEND === 'true';
    return append ? [...new Set([...DEFAULT_ROOTS(), ...custom])] : custom;
  }
  return DEFAULT_ROOTS();
};

/** Expose the computed allowlist for structured error responses. */
export function getAllowedRoots(): string[] {
  return ALLOWED_ROOTS();
}

/**
 * Check if a path is an allowed project directory.
 *
 * 1. Resolves the path to absolute
 * 2. Uses realpath() to follow symlinks and canonicalize
 * 3. Checks the real path is under an allowed root (with separator boundary)
 * 4. Verifies the path is an existing directory
 *
 * @returns The canonicalized real path if valid, or null if rejected.
 */
export async function validateProjectPath(rawPath: string): Promise<string | null> {
  try {
    const absPath = resolve(rawPath);
    // realpath resolves symlinks → canonical path
    const realPath = await realpath(absPath);

    if (!isUnderAllowedRoot(realPath)) return null;

    const info = await stat(realPath);
    if (!info.isDirectory()) return null;

    return realPath;
  } catch {
    // ENOENT, EACCES, etc.
    return null;
  }
}

export function isPathUnderRoots(absPath: string, allowedRoots: string[], platformName = process.platform): boolean {
  const isWindows = platformName === 'win32';
  for (const root of allowedRoots) {
    const rel = isWindows ? win32.relative(root, absPath) : relative(root, absPath);
    if (rel === '') {
      return true;
    }
    if (isWindows && win32.isAbsolute(rel)) {
      continue;
    }
    if (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\')) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a path string (without fs access) is plausibly under an allowed root.
 * Uses separator-aware relative() check instead of naive startsWith().
 *
 * For full validation (including symlinks), use validateProjectPath().
 */
export function isUnderAllowedRoot(absPath: string): boolean {
  return isPathUnderRoots(absPath, ALLOWED_ROOTS());
}

/**
 * Cross-platform path equality.
 * Case-insensitive on Windows (NTFS is case-preserving but case-insensitive).
 * Accepts optional platformName for testability on non-Windows CI.
 */
export function pathsEqual(a: string, b: string, platformName = process.platform): boolean {
  if (platformName !== 'win32') return a === b;
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}
