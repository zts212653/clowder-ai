export const CHAT_THREAD_ROUTE_EVENT = 'catcafe:thread-route-change';
export const CLASSIC_WORLD_PREFIX = '/classic';

export interface ThreadNavigationWindow {
  dispatchEvent: (event: Event) => boolean;
  history: {
    pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
  };
  location: {
    pathname: string;
  };
}

export interface DocumentNavigationWindow {
  location: {
    assign: (url: string) => void;
  };
}

function normalizePrefix(prefix = ''): string {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getThreadHref(threadId: string, prefix = ''): string {
  const normalizedPrefix = normalizePrefix(prefix);
  if (threadId === 'default') return normalizedPrefix || '/';
  return `${normalizedPrefix}/thread/${encodeURIComponent(threadId)}`;
}

export function getClassicThreadHref(threadId: string): string {
  return getThreadHref(threadId, CLASSIC_WORLD_PREFIX);
}

export function getWorldSwitchHref(pathname: string, referrerThreadId?: string): string {
  const inClassicWorld = pathname.startsWith(CLASSIC_WORLD_PREFIX);
  const threadId = getThreadIdFromPathname(pathname, inClassicWorld ? CLASSIC_WORLD_PREFIX : '');
  const resolvedId = threadId !== 'default' ? threadId : (referrerThreadId ?? 'default');
  return getThreadHref(resolvedId, inClassicWorld ? '' : CLASSIC_WORLD_PREFIX);
}

export function getThreadIdFromPathname(pathname: string, prefix = ''): string {
  const normalizedPrefix = normalizePrefix(prefix);
  if (!pathname || pathname === normalizedPrefix || pathname === `${normalizedPrefix}/`) return 'default';
  const match = normalizedPrefix
    ? pathname.match(new RegExp(`^${escapeRegExp(normalizedPrefix)}/thread/([^/?#]+)`))
    : pathname.match(/^\/thread\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : 'default';
}

export function pushThreadRouteWithHistory(
  threadId: string,
  windowObj: ThreadNavigationWindow | undefined,
  prefix = '',
): string {
  const href = getThreadHref(threadId, prefix);
  if (!windowObj) return href;
  if (windowObj.location.pathname === href) return href;
  windowObj.history.pushState({}, '', href);
  windowObj.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
  return href;
}

export function detectRoutePrefix(): string {
  if (typeof window === 'undefined') return '';
  return window.location.pathname.startsWith(CLASSIC_WORLD_PREFIX) ? CLASSIC_WORLD_PREFIX : '';
}

export function assignDocumentRoute(href: string, windowObj: DocumentNavigationWindow | undefined): string {
  if (windowObj) {
    windowObj.location.assign(href);
  }
  return href;
}
