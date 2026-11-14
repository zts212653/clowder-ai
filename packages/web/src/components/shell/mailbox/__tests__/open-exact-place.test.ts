// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  order: [] as string[],
  remembered: 'thread-return' as string | null,
  navigate: vi.fn(),
  push: vi.fn(),
  pushRoute: vi.fn(),
  thread: vi.fn(),
  mode: vi.fn(),
  dispatch: vi.fn(),
  foreground: vi.fn(),
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
  useChatStore: {
    getState: () => ({
      currentThreadId: calls.remembered,
      setWorkspaceMode: calls.mode,
      setCurrentThread: calls.thread,
    }),
  },
}));

vi.mock('@/components/workbench/experience-workbench-store', () => ({
  useF307ExperienceWorkbenchStore: { getState: () => ({ dispatch: calls.dispatch }) },
}));
vi.mock('@/components/workbench/workspace-presentation-lock', () => ({
  rememberWorkspaceForeground: calls.foreground,
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
    '/thread/current',
    '/',
    '/settings',
    '/memory',
  ])('opens the exact review and its owning conversation from %s', (pathname) => {
    const reviewId = `review-${'a'.repeat(64)}`;
    // Remembered thread state cannot stand in for the page the user actually sees.
    calls.remembered = 'review-thread';
    openExactPlace(`workspace:content-review:review-thread:${reviewId}`, pathname, calls.pushRoute);
    expect(calls.mode).toHaveBeenCalledWith('dev');
    expect(calls.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'open-surface',
        surface: expect.objectContaining({
          id: `content-review:${reviewId}`,
          ownerStateRef: { owner: 'f309-content-review', key: reviewId },
        }),
      }),
    );
    expect(calls.navigate).not.toHaveBeenCalled();
    expect(calls.thread).toHaveBeenCalledExactlyOnceWith('review-thread');
    expect(calls.pushRoute).toHaveBeenCalledExactlyOnceWith('/thread/review-thread');
    expect(calls.push).not.toHaveBeenCalled();
    expect(calls.foreground).toHaveBeenCalledOnce();
  });

  it('does not push a second history entry when the owning review conversation is already visible', () => {
    openExactPlace(
      `workspace:content-review:review-thread:review-${'a'.repeat(64)}`,
      '/thread/review-thread',
      calls.pushRoute,
    );
    expect(calls.dispatch).toHaveBeenCalledOnce();
    expect(calls.push).not.toHaveBeenCalled();
    expect(calls.pushRoute).not.toHaveBeenCalled();
  });

  it.each([
    '/settings',
    '/memory',
    '/collective',
  ])('from %s, a source in the remembered conversation still routes there: the page is not that conversation', (pathname) => {
    openExactPlace(message('thread-return'), pathname, calls.pushRoute);
    expect(calls.navigate).toHaveBeenCalledWith(message('thread-return'));
    expect(calls.push).toHaveBeenCalledWith('thread-return');
  });

  it('records the coordinate first (the navigation function), then routes, so the arriving conversation can reveal it', () => {
    openExactPlace(message('thread-return'), '/settings', calls.pushRoute);
    expect(calls.order).toEqual(['navigate', 'push']);
  });

  it('from the home route a source in the remembered conversation also routes there', () => {
    openExactPlace(message('thread-return'), '/', calls.pushRoute);
    expect(calls.push).toHaveBeenCalledWith('thread-return');
  });

  it('inside that same conversation it only scrolls: no route is pushed', () => {
    openExactPlace(message('thread-return'), '/thread/thread-return', calls.pushRoute);
    expect(calls.navigate).toHaveBeenCalledTimes(1);
    expect(calls.push).not.toHaveBeenCalled();
  });

  it.each([
    '/settings',
    '/thread/thread-return',
    '/',
  ])('a source in a conversation that is not the remembered one is routed by the navigation function itself, from %s', (pathname) => {
    openExactPlace(message('thread-other'), pathname, calls.pushRoute);
    expect(calls.navigate).toHaveBeenCalledWith(message('thread-other'));
    // Pushing again would be a second assignment of the same address.
    expect(calls.push).not.toHaveBeenCalled();
  });

  it('with nothing remembered, the navigation function routes it', () => {
    calls.remembered = null;
    openExactPlace(message('thread-return'), '/settings', calls.pushRoute);
    expect(calls.push).not.toHaveBeenCalled();
  });

  it('a collective-work result is the navigation function’s own full-page navigation: nothing is added', () => {
    const actionRef =
      '/collective?connectionId=con_abcdefgh&workId=work_abcdefgh&workRevision=2&channelId=general&resultEventId=evt_abcdefgh';
    openExactPlace(actionRef, '/settings', calls.pushRoute);
    expect(calls.navigate).toHaveBeenCalledWith(actionRef);
    expect(calls.push).not.toHaveBeenCalled();
  });

  it('a ref this build cannot read is handed to the navigation function and nothing more', () => {
    openExactPlace('something-new:xyz', '/settings', calls.pushRoute);
    expect(calls.navigate).toHaveBeenCalledWith('something-new:xyz');
    expect(calls.push).not.toHaveBeenCalled();
  });
});
