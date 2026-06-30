import { describe, expect, it } from 'vitest';
import {
  assignDocumentRoute,
  CHAT_THREAD_ROUTE_EVENT,
  getThreadHref,
  getThreadIdFromPathname,
  pushThreadRouteWithHistory,
  type ThreadNavigationWindow,
} from '../ThreadSidebar/thread-navigation';

function createFakeWindow(pathname: string): ThreadNavigationWindow & { dispatched: string[] } {
  const dispatched: string[] = [];
  const location = { pathname };
  return {
    dispatched,
    dispatchEvent: (event) => {
      dispatched.push(event.type);
      return true;
    },
    history: {
      pushState: (_data, _unused, url) => {
        location.pathname = typeof url === 'string' ? url : (url?.toString() ?? location.pathname);
      },
    },
    location,
  };
}

describe('thread navigation history bridge', () => {
  it('builds the expected href for default and regular threads', () => {
    expect(getThreadHref('default')).toBe('/');
    expect(getThreadHref('thread-123')).toBe('/thread/thread-123');
  });

  it('derives the active thread id from the pathname', () => {
    expect(getThreadIdFromPathname('/')).toBe('default');
    expect(getThreadIdFromPathname('/thread/thread-123')).toBe('thread-123');
    expect(getThreadIdFromPathname('/memory')).toBe('default');
  });

  it('pushes the new thread URL into history and emits a route event', () => {
    const fakeWindow = createFakeWindow('/thread/thread-a');
    const href = pushThreadRouteWithHistory('thread-b', fakeWindow);

    expect(href).toBe('/thread/thread-b');
    expect(fakeWindow.location.pathname).toBe('/thread/thread-b');
    expect(fakeWindow.dispatched).toEqual([CHAT_THREAD_ROUTE_EVENT]);
  });

  it('is idempotent when already on the target thread', () => {
    const fakeWindow = createFakeWindow('/thread/thread-b');
    const href = pushThreadRouteWithHistory('thread-b', fakeWindow);

    expect(href).toBe('/thread/thread-b');
    expect(fakeWindow.location.pathname).toBe('/thread/thread-b');
    expect(fakeWindow.dispatched).toEqual([]);
  });

  it('uses full-page navigation when current route is outside (chat) group (BUG-UX-12b)', () => {
    // When on /settings (non-chat route), the (chat)/layout.tsx event listener
    // is not mounted — pushState alone won't trigger React re-render.
    // pushThreadRouteWithHistory should fall back to location.assign.
    const assigned: string[] = [];
    const fakeWindow = createFakeWindow('/settings');
    (fakeWindow.location as { pathname: string; assign?: (url: string) => void }).assign = (url: string) =>
      assigned.push(url);

    const href = pushThreadRouteWithHistory('thread-123', fakeWindow);

    expect(href).toBe('/thread/thread-123');
    expect(assigned).toEqual(['/thread/thread-123']);
    // Must NOT use pushState/dispatchEvent path (no listener on non-chat pages)
    expect(fakeWindow.dispatched).toEqual([]);
  });

  it('still uses pushState for in-chat navigation (/, /thread/*)', () => {
    // Existing behavior: in-chat routes use pushState + event
    for (const path of ['/', '/thread/thread-a']) {
      const fakeWindow = createFakeWindow(path);
      pushThreadRouteWithHistory('thread-new', fakeWindow);
      expect(fakeWindow.dispatched).toEqual([CHAT_THREAD_ROUTE_EVENT]);
    }
  });

  it('assigns document routes for hub navigation outside the chat route store', () => {
    const assigned: string[] = [];
    const href = assignDocumentRoute('/memory?from=thread-b', {
      location: {
        assign: (url) => assigned.push(url),
      },
    });

    expect(href).toBe('/memory?from=thread-b');
    expect(assigned).toEqual(['/memory?from=thread-b']);
  });
});
