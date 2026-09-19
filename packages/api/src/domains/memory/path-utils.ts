// Shared path helpers for memory identifiers.
//
// Collection anchors, `sourcePath` values and `exclude` globs are POSIX-style identifiers:
// `matchGlob` only understands `/`, and consumers such as readCanonicalProjectDocument() and
// classifyTasteSourcePath() explicitly reject any sourcePath containing `\`. `path.relative`
// returns `\` on Windows, so every boundary that turns a filesystem path into such an identifier
// must normalize first — otherwise `exclude` silently stops working (a user-excluded directory
// keeps being scanned, which can trip the fail-closed secret purge) and anchors drift per platform.
//
// The same separator assumption breaks containment checks: `child.startsWith(parent + '/')` is
// always false on Windows, so callers must use isPathInside() instead.

import { isAbsolute, relative, sep } from 'node:path';

/**
 * Convert a platform-native relative path into the POSIX-style identifier contract.
 *
 * `\` is a separator **only on Windows**; on POSIX it is a legal filename character. Rewriting it
 * unconditionally made `foo/bar.md` and the distinct file `foo\bar.md` collapse onto one canonical
 * identity, and turned the literal filename `..\outside.md` into a traversal-looking `../outside.md`.
 * So convert only where the platform actually uses `\` as a separator.
 */
export function toPosixPath(relPath: string): string {
  return sep === '\\' ? relPath.replace(/\\/g, '/') : relPath;
}

/**
 * True when `candidate` is `root` itself or nested inside it. Both paths must come from the same
 * platform-native producer (`resolve`/`realpath`).
 *
 * Containment is delegated to the native `relative()` (the boundary pattern already used elsewhere
 * in the API) so that win32 drive/case semantics apply: a plain string prefix is both
 * separator-blind and case-sensitive, which made `C:\Project` vs `c:\project\docs` look unrelated
 * and silently skipped the child exclude.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true; // same directory (win32 may differ only by case)
  if (isAbsolute(rel)) return false; // different volume/drive on win32
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}
