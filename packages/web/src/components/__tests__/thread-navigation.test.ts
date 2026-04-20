import { describe, expect, it } from 'vitest';
import {
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
});
