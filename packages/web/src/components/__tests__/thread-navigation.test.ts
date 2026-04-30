import { describe, expect, it } from 'vitest';
import {
  assignDocumentRoute,
  CHAT_THREAD_ROUTE_EVENT,
  CLASSIC_WORLD_PREFIX,
  getClassicThreadHref,
  getThreadHref,
  getThreadIdFromPathname,
  getWorldSwitchHref,
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
  it('builds the expected href for default and regular threads in both worlds', () => {
    expect(getThreadHref('default')).toBe('/');
    expect(getThreadHref('thread-123')).toBe('/thread/thread-123');
    expect(getClassicThreadHref('default')).toBe('/classic');
    expect(getClassicThreadHref('thread-123')).toBe('/classic/thread/thread-123');
  });

  it('derives the active thread id from the pathname for console and classic routes', () => {
    expect(getThreadIdFromPathname('/')).toBe('default');
    expect(getThreadIdFromPathname('/thread/thread-123')).toBe('thread-123');
    expect(getThreadIdFromPathname('/classic', CLASSIC_WORLD_PREFIX)).toBe('default');
    expect(getThreadIdFromPathname('/classic/thread/thread-123', CLASSIC_WORLD_PREFIX)).toBe('thread-123');
    expect(getThreadIdFromPathname('/memory')).toBe('default');
  });

  it('switches between new world and classic while preserving the current thread when available', () => {
    expect(getWorldSwitchHref('/')).toBe('/classic');
    expect(getWorldSwitchHref('/signals')).toBe('/classic');
    expect(getWorldSwitchHref('/thread/thread-123')).toBe('/classic/thread/thread-123');
    expect(getWorldSwitchHref('/classic')).toBe('/');
    expect(getWorldSwitchHref('/classic/thread/thread-123')).toBe('/thread/thread-123');
  });

  it('uses referrerThreadId as fallback when pathname has no thread', () => {
    expect(getWorldSwitchHref('/signals', 'thread-abc')).toBe('/classic/thread/thread-abc');
    expect(getWorldSwitchHref('/memory', 'thread-xyz')).toBe('/classic/thread/thread-xyz');
    expect(getWorldSwitchHref('/thread/thread-123', 'ignored')).toBe('/classic/thread/thread-123');
    expect(getWorldSwitchHref('/', 'thread-abc')).toBe('/classic/thread/thread-abc');
  });

  it('pushes the new thread URL into history and emits a route event inside the classic world', () => {
    const fakeWindow = createFakeWindow('/classic/thread/thread-a');
    const href = pushThreadRouteWithHistory('thread-b', fakeWindow, CLASSIC_WORLD_PREFIX);

    expect(href).toBe('/classic/thread/thread-b');
    expect(fakeWindow.location.pathname).toBe('/classic/thread/thread-b');
    expect(fakeWindow.dispatched).toEqual([CHAT_THREAD_ROUTE_EVENT]);
  });

  it('is idempotent when already on the target thread', () => {
    const fakeWindow = createFakeWindow('/classic/thread/thread-b');
    const href = pushThreadRouteWithHistory('thread-b', fakeWindow, CLASSIC_WORLD_PREFIX);

    expect(href).toBe('/classic/thread/thread-b');
    expect(fakeWindow.location.pathname).toBe('/classic/thread/thread-b');
    expect(fakeWindow.dispatched).toEqual([]);
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
