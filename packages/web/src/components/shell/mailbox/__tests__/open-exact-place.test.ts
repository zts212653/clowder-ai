import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  order: [] as string[],
  remembered: 'thread-return' as string | null,
  navigate: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/hooks/useWorkspaceNavigate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useWorkspaceNavigate')>()),
  navigateToEntrustedWorkAction: (actionRef: string) => {
    calls.order.push('navigate');
    calls.navigate(actionRef);
    return true;
  },
}));
vi.mock('@/components/ThreadSidebar/thread-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ThreadSidebar/thread-navigation')>()),
  pushThreadRouteWithHistory: (threadId: string) => {
    calls.order.push('push');
    calls.push(threadId);
    return `/thread/${threadId}`;
  },
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ currentThreadId: calls.remembered }) },
}));

import { openExactPlace } from '../open-exact-place';

const message = (threadId: string) => `message:${threadId}:msg-9#block-1`;

describe('opening an exact source from wherever the user is', () => {
  beforeEach(() => {
    calls.order.length = 0;
    calls.remembered = 'thread-return';
    vi.clearAllMocks();
  });

  it.each([
    '/settings',
    '/memory',
    '/collective',
  ])('from %s, a source in the remembered conversation still routes there: the page is not that conversation', (pathname) => {
    openExactPlace(message('thread-return'), pathname);
    expect(calls.navigate).toHaveBeenCalledWith(message('thread-return'));
    expect(calls.push).toHaveBeenCalledWith('thread-return');
  });

  it('records the coordinate first (the navigation function), then routes, so the arriving conversation can reveal it', () => {
    openExactPlace(message('thread-return'), '/settings');
    expect(calls.order).toEqual(['navigate', 'push']);
  });

  it('from the home route a source in the remembered conversation also routes there', () => {
    openExactPlace(message('thread-return'), '/');
    expect(calls.push).toHaveBeenCalledWith('thread-return');
  });

  it('inside that same conversation it only scrolls: no route is pushed', () => {
    openExactPlace(message('thread-return'), '/thread/thread-return');
    expect(calls.navigate).toHaveBeenCalledTimes(1);
    expect(calls.push).not.toHaveBeenCalled();
  });

  it.each([
    '/settings',
    '/thread/thread-return',
    '/',
  ])('a source in a conversation that is not the remembered one is routed by the navigation function itself, from %s', (pathname) => {
    openExactPlace(message('thread-other'), pathname);
    expect(calls.navigate).toHaveBeenCalledWith(message('thread-other'));
    // Pushing again would be a second assignment of the same address.
    expect(calls.push).not.toHaveBeenCalled();
  });

  it('with nothing remembered, the navigation function routes it', () => {
    calls.remembered = null;
    openExactPlace(message('thread-return'), '/settings');
    expect(calls.push).not.toHaveBeenCalled();
  });

  it('a collective-work result is the navigation function’s own full-page navigation: nothing is added', () => {
    const actionRef =
      '/collective?connectionId=con_abcdefgh&workId=work_abcdefgh&workRevision=2&channelId=general&resultEventId=evt_abcdefgh';
    openExactPlace(actionRef, '/settings');
    expect(calls.navigate).toHaveBeenCalledWith(actionRef);
    expect(calls.push).not.toHaveBeenCalled();
  });

  it('a ref this build cannot read is handed to the navigation function and nothing more', () => {
    openExactPlace('something-new:xyz', '/settings');
    expect(calls.navigate).toHaveBeenCalledWith('something-new:xyz');
    expect(calls.push).not.toHaveBeenCalled();
  });
});
