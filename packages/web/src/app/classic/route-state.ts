import { CLASSIC_WORLD_PREFIX, getThreadIdFromPathname } from '@/components/ThreadSidebar/thread-navigation';

function getThreadRouteSnapshot(): string {
  if (typeof window === 'undefined') return 'default';
  return getThreadIdFromPathname(window.location.pathname, CLASSIC_WORLD_PREFIX);
}

export function resolveLayoutThreadId(
  pathnameThreadId: string,
  browserThreadId: string | null,
  immediateBrowserThreadId: string | null = null,
): string {
  if (browserThreadId !== null) return browserThreadId;
  if (immediateBrowserThreadId !== null) return immediateBrowserThreadId;
  return pathnameThreadId;
}

export { getThreadRouteSnapshot };
