/**
 * Project Path Validation
 * 共享的路径安全校验，防止路径遍历和 symlink 逃逸。
 *
 * Default mode: **denylist** — block known system directories, allow everything else.
 * Legacy mode: if PROJECT_ALLOWED_ROOTS is set, uses allowlist (backward compat).
 *
 * See: https://github.com/zts212653/clowder-ai/issues/228
 */

import { realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, relative, resolve, win32 } from 'node:path';

// ---------------------------------------------------------------------------
// Denylist: known system directories that should never be project roots
// ---------------------------------------------------------------------------

export function getDefaultDeniedRoots(platformName = platform()): string[] {
  if (platformName === 'win32') {
    const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows';
    return [resolve(systemRoot)];
  }
  if (platformName === 'darwin') {
    return ['/dev', '/sbin', '/System'];
  }
  // linux / others
  return ['/proc', '/sys', '/dev', '/boot', '/sbin', '/run'];
}

function DENIED_ROOTS(): string[] {
  const envDenied = process.env.PROJECT_DENIED_ROOTS;
  const defaults = getDefaultDeniedRoots();
  if (envDenied?.trim()) {
    const custom = envDenied.split(delimiter).filter(Boolean);
    return [...new Set([...defaults, ...custom])];
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Legacy allowlist (only active when PROJECT_ALLOWED_ROOTS is set)
// ---------------------------------------------------------------------------

/**
 * Legacy default roots for allowlist mode (pre-#228).
 * Used when PROJECT_ALLOWED_ROOTS_APPEND=true merges custom roots with defaults.
 */
function legacyDefaultRoots(platformName = platform()): string[] {
  const roots = new Set<string>([homedir()]);
  if (platformName === 'win32') return [...roots];
  roots.add('/tmp');
  roots.add('/private/tmp');
  roots.add('/workspace');
  if (platformName === 'darwin') roots.add('/Volumes');
  return [...roots];
}

function LEGACY_ALLOWED_ROOTS(): string[] | null {
  const envRoots = process.env.PROJECT_ALLOWED_ROOTS;
  if (!envRoots?.trim()) return null;
  const custom = envRoots.split(delimiter).filter(Boolean);
  const append = process.env.PROJECT_ALLOWED_ROOTS_APPEND === 'true';
  return append ? [...new Set([...legacyDefaultRoots(), ...custom])] : custom;
}

// ---------------------------------------------------------------------------
// Public API (kept backward-compatible)
// ---------------------------------------------------------------------------

/**
 * Returns restriction info for error messages.
 * - Denylist mode: returns denied roots
 * - Allowlist mode: returns allowed roots
 */
export function getAllowedRoots(): string[] {
  const legacy = LEGACY_ALLOWED_ROOTS();
  if (legacy) return legacy;
  return DENIED_ROOTS();
}

/** Returns true if path validation uses denylist mode (default). */
export function isDenylistMode(): boolean {
  return LEGACY_ALLOWED_ROOTS() === null;
}

/**
 * Check if a path is an allowed project directory.
 *
 * 1. Resolves the path to absolute
 * 2. Uses realpath() to follow symlinks and canonicalize
 * 3. Checks the real path against denylist (or allowlist in legacy mode)
 * 4. Verifies the path is an existing directory
 *
 * @returns The canonicalized real path if valid, or null if rejected.
 */
export async function validateProjectPath(rawPath: string): Promise<string | null> {
  try {
    const absPath = resolve(rawPath);
    const realPath = await realpath(absPath);

    if (!isUnderAllowedRoot(realPath)) return null;

    const info = await stat(realPath);
    if (!info.isDirectory()) return null;

    return realPath;
  } catch {
    return null;
  }
}

export function isPathUnderRoots(absPath: string, roots: string[], platformName = process.platform): boolean {
  const isWindows = platformName === 'win32';
  for (const root of roots) {
    const rel = isWindows ? win32.relative(root, absPath) : relative(root, absPath);
    if (rel === '') return true;
    if (isWindows && win32.isAbsolute(rel)) continue;
    if (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\')) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a path is allowed for project use.
 *
 * - Denylist mode (default): allowed unless under a denied root.
 * - Allowlist mode (PROJECT_ALLOWED_ROOTS set): allowed only if under an allowed root.
 */
export function isUnderAllowedRoot(absPath: string): boolean {
  const legacy = LEGACY_ALLOWED_ROOTS();
  if (legacy) {
    return isPathUnderRoots(absPath, legacy);
  }
  return !isPathUnderRoots(absPath, DENIED_ROOTS());
}

// Keep backward-compat export — returns legacy allowlist defaults for tests
export function getDefaultRootsForPlatform(platformName = platform(), opts?: { homeDir?: string }): string[] {
  if (opts?.homeDir) {
    const roots = new Set<string>([opts.homeDir]);
    if (platformName === 'win32') return [...roots];
    roots.add('/tmp');
    roots.add('/private/tmp');
    roots.add('/workspace');
    if (platformName === 'darwin') roots.add('/Volumes');
    return [...roots];
  }
  return legacyDefaultRoots(platformName);
}
