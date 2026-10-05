import { getThreadIdFromPathname } from '../ThreadSidebar/thread-navigation';

/**
 * Rail navigation target resolution shared by the classic ActivityBar and the F322 v2 rail, so both carry the
 * same referrer: leaving a thread for a global page appends `?from=<thread>` so the way back is the last thread.
 */
function readFromParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('from');
}

function getNavigationReferrer(pathname: string): string | null {
  const threadId = getThreadIdFromPathname(pathname);
  return threadId !== 'default' ? threadId : readFromParam();
}

function appendReferrer(path: string, referrer: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}from=${encodeURIComponent(referrer)}`;
}

/** The Café destinations that live on their own page but keep the sidebar. Today only 记忆. */
export type ShellDestination = 'memory';

/** The memory route family: `/memory` and everything under it, not any path that merely starts with the word. */
export function isMemoryRoute(pathname: string): boolean {
  return pathname === '/memory' || pathname.startsWith('/memory/');
}

export function resolveShellNavTarget(path: string, pathname: string): string {
  if (path === '/') {
    const fromParam = readFromParam();
    return fromParam ? `/thread/${encodeURIComponent(fromParam)}` : '/';
  }
  const referrer = getNavigationReferrer(pathname);
  return referrer ? appendReferrer(path, referrer) : path;
}
