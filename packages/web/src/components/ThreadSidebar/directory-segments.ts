/**
 * F113 directory path parsing utilities.
 * Extracted from DirectoryBrowser.tsx (R3 review P2#4: split root-navigation slice).
 */

export interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface BrowseResult {
  current: string;
  name: string;
  parent: string | null;
  homePath: string;
  entries: BrowseEntry[];
  /** Server-owned capability: true when the API server's filesystem is Windows. */
  isWindows?: boolean;
}

export interface BreadcrumbSegment {
  label: string;
  path: string;
}

/**
 * Build breadcrumb segments for a Windows drive path (e.g. "D:\XXX").
 * The drive root is its own clickable segment so the user can navigate back
 * to "D:\" - without this, the drive letter layer is silently swallowed and
 * the breadcrumb reads "此电脑 > XXX" instead of "此电脑 > D: > XXX".
 * Drive root path keeps the trailing separator (realpath needs it to resolve
 * the drive rather than cwd-on-drive).
 */
export function windowsDriveSegments(absPath: string, sep: string): BreadcrumbSegment[] {
  const parts = absPath.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) return [];

  const driveRoot = `${parts[0]}${sep}`;
  const segments: BreadcrumbSegment[] = [{ label: parts[0], path: driveRoot }];
  let accumulated = driveRoot;
  for (let i = 1; i < parts.length; i++) {
    accumulated = accumulated.endsWith(sep) ? `${accumulated}${parts[i]}` : `${accumulated}${sep}${parts[i]}`;
    segments.push({ label: parts[i], path: accumulated });
  }
  return segments;
}

/**
 * Parse an absolute path into breadcrumb segments.
 * When path is under homePath: Home > relative segments (each clickable).
 * When path is outside homePath (e.g. /tmp, /Volumes): show the full path
 * segments from the allowed root, using the parent field for "go up".
 * Handles both / and \ separators for cross-platform support.
 */
export function pathToSegments(absPath: string, homePath: string): BreadcrumbSegment[] {
  const sep = absPath.includes('\\') ? '\\' : '/';

  // Case 1: path is at or under home - use "Home" as root label
  if (absPath === homePath || absPath.startsWith(homePath + sep)) {
    const segments: BreadcrumbSegment[] = [{ label: 'Home', path: '' }];
    if (absPath === homePath) return segments;

    const relative = absPath.slice(homePath.length + 1);
    if (!relative) return segments;

    const parts = relative.split(/[/\\]/).filter(Boolean);
    let accumulated = homePath;
    for (const part of parts) {
      accumulated += sep + part;
      segments.push({ label: part, path: accumulated });
    }
    return segments;
  }

  // Case 2: path is outside home - all segments are clickable.
  // We can't know the full allowlist on the frontend. If the user clicks
  // a non-allowed ancestor, the backend returns 403 and the error is shown
  // gracefully. This is better than hiding valid ancestors like /tmp which
  // IS in the default allowlist (project-path.ts:22-35).
  if (/^[A-Za-z]:[\\/]?/.test(absPath)) {
    return windowsDriveSegments(absPath, sep);
  }

  const parts = absPath.split(/[/\\]/).filter(Boolean);
  const segments: BreadcrumbSegment[] = [];
  let accumulated = absPath.startsWith('/') ? '' : parts[0];
  const startIdx = absPath.startsWith('/') ? 0 : 1;
  for (let i = startIdx; i < parts.length; i++) {
    accumulated += sep + parts[i];
    segments.push({ label: parts[i], path: accumulated });
  }

  return segments;
}

/** Build the browse API URL for an optional path argument. */
export function buildBrowseUrl(path?: string): string {
  return path ? `/api/projects/browse?path=${encodeURIComponent(path)}` : '/api/projects/browse';
}

/** Whether a failed browse response should trigger the homedir fallback. */
export function shouldFallbackToHome(fallbackOnForbidden: boolean, path: string | undefined, status: number): boolean {
  return fallbackOnForbidden && Boolean(path) && status === 403;
}
