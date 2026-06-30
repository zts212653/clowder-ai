export const CHAT_THREAD_ROUTE_EVENT = 'catcafe:thread-route-change';

export interface ThreadNavigationWindow {
  dispatchEvent: (event: Event) => boolean;
  history: {
    pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
  };
  location: {
    pathname: string;
    /** Available on the real window; optional for test fakes. */
    assign?: (url: string) => void;
  };
}

export interface DocumentNavigationWindow {
  location: {
    assign: (url: string) => void;
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

  // BUG-UX-12b: when navigating FROM outside the (chat) route group (e.g. /settings,
  // /mission-hub), the CHAT_THREAD_ROUTE_EVENT listener in (chat)/layout.tsx is not
  // mounted — pushState alone changes the URL but React never re-renders, leaving the
  // old page visible alongside a partially-updated thread sidebar.
  // Detect non-chat routes and fall back to location.assign (full page navigation).
  const p = windowObj.location.pathname;
  const inChatRoute = p === '/' || p.startsWith('/thread/');
  if (!inChatRoute && windowObj.location.assign) {
    windowObj.location.assign(href);
    return href;
  }

  windowObj.history.pushState({}, '', href);
  windowObj.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
  return href;
}

export function assignDocumentRoute(href: string, windowObj: DocumentNavigationWindow | undefined): string {
  if (windowObj) {
    windowObj.location.assign(href);
  }
  return href;
}
