/**
 * P1 regression: split-pane Stop should project against the selected pane's
 * thread, not the URL threadId.
 *
 * ChatInput owns the durable execution cancellation control, so SplitPaneView
 * must bind it to splitPaneTargetId.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStoreState = () => ({
  threads: [
    {
      id: 'thread-a',
      title: 'Thread A',
      projectPath: 'p',
      createdBy: 'u',
      participants: [],
      lastActiveAt: 0,
      createdAt: 0,
    },
    {
      id: 'thread-b',
      title: 'Thread B',
      projectPath: 'p',
      createdBy: 'u',
      participants: [],
      lastActiveAt: 0,
      createdAt: 0,
    },
  ],
  splitPaneThreadIds: ['thread-a', 'thread-b'],
  splitPaneTargetId: 'thread-b',
  setSplitPaneTarget: vi.fn(),
  setSplitPaneThreadIds: vi.fn(),
  getThreadState: () => ({
    messages: [],
    isLoading: true,
    isLoadingHistory: false,
    hasMore: true,
    hasActiveInvocation: true,
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    currentGame: null,

    unreadCount: 0,
    lastActivity: 0,
  }),
});

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: ReturnType<typeof mockStoreState>) => unknown) => {
    const state = mockStoreState();
    return selector ? selector(state) : state;
  };
  return { useChatStore: hook };
});

vi.mock('@/components/ChatInput', () => ({
  ChatInput: ({ threadId }: { threadId?: string }) =>
    React.createElement('div', { 'data-testid': 'chat-input', 'data-thread-id': threadId }),
}));

vi.mock('@/components/SplitPaneCell', () => ({
  SplitPaneCell: () => null,
  SplitPanePlaceholder: () => null,
}));

vi.mock('@/components/MiniThreadSidebar', () => ({
  MiniThreadSidebar: () => null,
}));

import { SplitPaneView } from '@/components/SplitPaneView';

describe('SplitPaneView stop routing (P1 regression)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('binds ChatInput cancellation projection to splitPaneTargetId', () => {
    act(() => {
      root.render(
        React.createElement(SplitPaneView, {
          onSend: vi.fn(),
          onZoomToThread: vi.fn(),
        }),
      );
    });

    expect(container.querySelector('[data-testid="chat-input"]')?.getAttribute('data-thread-id')).toBe('thread-b');
  });
});
