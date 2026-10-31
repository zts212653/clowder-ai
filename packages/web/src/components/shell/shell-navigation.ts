import { getThreadHref, getThreadIdFromPathname } from '../ThreadSidebar/thread-navigation';

const CAFE_RETURN_STORAGE_KEY = 'cat-cafe:shell-cafe-return:v1';

/**
 * Rail navigation target resolution shared by the classic ActivityBar and the F322 v2 rail, so both carry the
 * same referrer: leaving a thread for a global page appends `?from=<thread>` so the way back is the last thread.
 */
function readFromParam(): string | null {
  if (typeof window === 'undefined') return null;
  return validThreadId(new URLSearchParams(window.location.search).get('from'));
}

function validThreadId(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 200 && !/[/?#]/u.test(trimmed) ? trimmed : null;
}

function readRememberedCafeTarget(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.sessionStorage.getItem(CAFE_RETURN_STORAGE_KEY);
    if (value === '/') return value;
    const threadId = value ? getThreadIdFromPathname(value) : 'default';
    return threadId === 'default' ? null : getThreadHref(threadId);
  } catch {
    return null;
  }
}

export function rememberCafeReturnTarget(pathname: string): void {
  if (typeof window === 'undefined') return;
  const threadId = getThreadIdFromPathname(pathname);
  const target = pathname === '/' ? '/' : threadId !== 'default' ? getThreadHref(threadId) : null;
  const from = readFromParam();
  const next = target ?? (from ? getThreadHref(from) : null);
  if (!next) return;
  try {
    window.sessionStorage.setItem(CAFE_RETURN_STORAGE_KEY, next);
  } catch {
    /* The exact URL still works when tab-scoped browser storage is unavailable. */
  }
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
    return fromParam ? getThreadHref(fromParam) : (readRememberedCafeTarget() ?? '/');
  }
  const referrer = getNavigationReferrer(pathname);
  return referrer ? appendReferrer(path, referrer) : path;
}
