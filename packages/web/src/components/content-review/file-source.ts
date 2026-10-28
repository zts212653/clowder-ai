import { workspaceContentLocatorSchema } from '@cat-cafe/shared';
import { API_URL } from '@/utils/api-client';

/** The production API origin is authoritative; the same-origin branch also supports relative test origins. */
export function contentApiBase() {
  return new URL(API_URL || (typeof window === 'undefined' ? 'http://localhost' : window.location.origin));
}

/** A URL can carry a locator candidate. Only the original file owner can authorize its read/write. */
export function workspaceFileSourceFromUrl(raw: string) {
  try {
    const api = contentApiBase();
    const url = new URL(raw, api);
    if (
      url.origin !== api.origin ||
      !['/api/workspace/file/raw', '/api/workspace/file/download'].includes(url.pathname)
    )
      return null;
    if ([...url.searchParams.keys()].some((key) => key !== 'worktreeId' && key !== 'path')) return null;
    if (url.searchParams.getAll('worktreeId').length !== 1 || url.searchParams.getAll('path').length !== 1) return null;
    const value = { worktreeId: url.searchParams.get('worktreeId'), path: url.searchParams.get('path') };
    const parsed = workspaceContentLocatorSchema.safeParse(value);
    return parsed.success && parsed.data.worktreeId === value.worktreeId && parsed.data.path === value.path
      ? { kind: 'workspace' as const, ...parsed.data }
      : null;
  } catch {
    return null;
  }
}

/** Do not put executable URL schemes into links, native downloads or media readers. */
export function contentFileUrl(raw: string): string | null {
  try {
    const url = new URL(raw, contentApiBase());
    return ['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'blob:' && typeof window !== 'undefined' && url.origin === window.location.origin)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
