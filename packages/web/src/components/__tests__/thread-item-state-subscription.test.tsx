import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadItem } from '@/components/ThreadSidebar/ThreadItem';
import { DEFAULT_THREAD_STATE } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const statusRender = vi.fn();

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => null, cats: [] }),
}));

vi.mock('@/components/ThreadCatStatus', () => ({
  ThreadCatStatus: ({ unreadCount, presence }: { unreadCount: number; presence: unknown }) => {
    statusRender(unreadCount, presence);
    return React.createElement('span', { 'data-testid': 'unread' }, String(unreadCount));
  },
}));

describe('ThreadItem snapshot authority', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    statusRender.mockReset();
    useChatStore.setState({
      currentThreadId: 'other-thread',
      threadStates: {
        'thread-1': { ...DEFAULT_THREAD_STATE, unreadCount: 1, lastActivity: 10 },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('ignores legacy unread, liveness, and lastActivity changes for a fixed snapshot row', () => {
    act(() => {
      root.render(
        React.createElement(ThreadItem, {
          id: 'thread-1',
          title: 'Thread 1',
          participants: ['codex-sol'],
          lastActiveAt: 100,
          isActive: false,
          onSelect: vi.fn(),
          presence: { status: 'working', cats: ['codex-sol'] },
          unreadCount: 2,
          hasUserMention: false,
        }),
      );
    });
    expect(container.querySelector('[data-testid="unread"]')?.textContent).toBe('2');

    act(() => {
      useChatStore.setState((state) => ({
        threadStates: {
          ...state.threadStates,
          'thread-1': {
            ...(state.threadStates['thread-1'] ?? DEFAULT_THREAD_STATE),
            unreadCount: 99,
            lastActivity: 999_999,
            hasActiveInvocation: false,
            catStatuses: { 'codex-sol': 'error' },
          },
        },
      }));
    });

    expect(container.querySelector('[data-testid="unread"]')?.textContent).toBe('2');
    expect(statusRender).toHaveBeenLastCalledWith(2, {
      status: 'working',
      cats: ['codex-sol'],
    });
  });

  it('changes status only when the parent supplies a newer snapshot row', () => {
    const render = (status: 'working' | 'done', unreadCount: number) =>
      React.createElement(ThreadItem, {
        id: 'thread-1',
        title: 'Thread 1',
        participants: ['codex-sol'],
        lastActiveAt: 100,
        isActive: false,
        onSelect: vi.fn(),
        presence: { status, cats: ['codex-sol'] },
        unreadCount,
        hasUserMention: false,
      });

    act(() => root.render(render('working', 3)));
    act(() => root.render(render('done', 0)));

    expect(statusRender).toHaveBeenLastCalledWith(0, { status: 'done', cats: ['codex-sol'] });
  });

  it('reserves inline paint inset before clipping crowded participant avatar rings', () => {
    act(() => {
      root.render(
        React.createElement(ThreadItem, {
          id: 'thread-1',
          title: 'Crowded thread',
          participants: Array.from({ length: 12 }, (_, index) => `cat-${index}`),
          preferredCats: ['codex-sol'],
          lastActiveAt: 100,
          isActive: false,
          onSelect: vi.fn(),
          presence: { status: 'done', cats: ['codex-sol'] },
          unreadCount: 2,
          hasUserMention: false,
        }),
      );
    });

    const metadataRail = container.querySelector('[data-testid="thread-participant-metadata"]');
    const status = container.querySelector('[data-testid="unread"]');

    expect(metadataRail).not.toBeNull();
    expect(metadataRail?.className).toContain('min-w-0');
    expect(metadataRail?.className).toContain('overflow-x-clip');
    expect(metadataRail?.className).toContain('overflow-y-visible');
    expect(metadataRail?.className).toContain('px-0.5');
    expect(metadataRail?.className).not.toContain('overflow-hidden');
    expect(metadataRail?.querySelector('.ring-2')).not.toBeNull();
    expect(metadataRail?.contains(status)).toBe(false);
    expect(metadataRail?.parentElement?.contains(status)).toBe(true);
  });

  it('renders and refreshes working elapsed from activeSince, never C7 lastActiveAt', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-20T12:00:00.000Z').getTime();
    vi.setSystemTime(now);
    try {
      act(() => {
        root.render(
          React.createElement(ThreadItem, {
            id: 'thread-1',
            title: 'Thread 1',
            participants: ['codex-sol'],
            lastActiveAt: now - 60_000,
            isActive: false,
            onSelect: vi.fn(),
            presence: { status: 'working', cats: ['codex-sol'], activeSince: now - 21 * 60_000 },
            unreadCount: 0,
            hasUserMention: false,
          }),
        );
      });
      expect(container.textContent).toContain('执行中 · 21分');
      expect(container.textContent).not.toContain('1分钟前');

      act(() => vi.advanceTimersByTime(60_000));
      expect(container.textContent).toContain('执行中 · 22分');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows plain working when canonical activeSince is absent', () => {
    act(() => {
      root.render(
        React.createElement(ThreadItem, {
          id: 'thread-1',
          title: 'Thread 1',
          participants: ['codex-sol'],
          lastActiveAt: Date.now() - 21 * 60_000,
          isActive: false,
          onSelect: vi.fn(),
          presence: { status: 'working', cats: ['codex-sol'] },
          unreadCount: 0,
          hasUserMention: false,
        }),
      );
    });
    expect(container.textContent).toContain('执行中');
    expect(container.textContent).not.toContain('21分');
  });

  it('keeps the admitted participant visible across working and completed snapshots', () => {
    const render = (status: 'working' | 'idle') =>
      React.createElement(ThreadItem, {
        id: 'thread-1',
        title: 'Approved proposal',
        participants: ['kimi'],
        lastActiveAt: 100,
        isActive: false,
        onSelect: vi.fn(),
        presence: { status, ...(status === 'working' ? { cats: ['kimi'] } : {}) },
        unreadCount: 0,
        hasUserMention: false,
      });

    act(() => root.render(render('working')));
    expect(container.querySelector('img[src="/avatars/kimi.png"]')).not.toBeNull();
    expect(container.textContent).not.toContain('还没有猫猫加入');

    act(() => root.render(render('idle')));
    expect(container.querySelector('img[src="/avatars/kimi.png"]')).not.toBeNull();
    expect(container.textContent).not.toContain('还没有猫猫加入');
  });
});
