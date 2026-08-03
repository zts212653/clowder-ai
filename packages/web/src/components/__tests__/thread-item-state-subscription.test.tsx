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

vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => null }));
vi.mock('@/components/ThreadCatStatus', () => ({
  ThreadCatStatus: ({ unreadCount }: { unreadCount: number }) => {
    statusRender(unreadCount);
    return React.createElement('span', { 'data-testid': 'unread' }, String(unreadCount));
  },
}));

describe('ThreadItem state subscription', () => {
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
        'thread-1': { ...DEFAULT_THREAD_STATE, unreadCount: 1 },
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

  it('reads its own thread state when the parent does not pass the global state map', () => {
    act(() => {
      root.render(
        React.createElement(ThreadItem, {
          id: 'thread-1',
          title: 'Thread 1',
          participants: [],
          lastActiveAt: 1,
          isActive: false,
          onSelect: vi.fn(),
        }),
      );
    });
    expect(container.querySelector('[data-testid="unread"]')?.textContent).toBe('1');

    act(() => {
      useChatStore.setState((state) => ({
        threadStates: {
          ...state.threadStates,
          'thread-1': { ...(state.threadStates['thread-1'] ?? DEFAULT_THREAD_STATE), unreadCount: 7 },
        },
      }));
    });

    expect(container.querySelector('[data-testid="unread"]')?.textContent).toBe('7');
  });
});
