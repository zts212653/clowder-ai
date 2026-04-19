export const CHAT_THREAD_ROUTE_EVENT = 'catcafe:thread-route-change';

export interface ThreadNavigationWindow {
  dispatchEvent: (event: Event) => boolean;
  history: {
    pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
  };
  location: {
    pathname: string;
  };
}

export function getThreadHref(threadId: string): string {
  return threadId === 'default' ? '/' : `/thread/${threadId}`;
}

export function getThreadIdFromPathname(pathname: string): string {
  if (!pathname || pathname === '/') return 'default';
  const match = pathname.match(/^\/thread\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : 'default';
}

export function pushThreadRouteWithHistory(threadId: string, windowObj: ThreadNavigationWindow | undefined): string {
  const href = getThreadHref(threadId);
  if (!windowObj) return href;
  if (windowObj.location.pathname === href) return href;
  windowObj.history.pushState({}, '', href);
  windowObj.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
  return href;
}
