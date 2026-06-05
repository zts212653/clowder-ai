/**
 * P1-1 regression test: split-pane input routing.
 *
 * Verifies that SplitPaneView passes splitPaneTargetId to onSend as overrideThreadId.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Track what onSend receives ──
const mockOnSend = vi.fn();

const mockStoreState = () => ({
  threads: [
    {
      id: 'thread-1',
      title: 'Thread 1',
      projectPath: 'p',
      createdBy: 'u',
      participants: [],
      lastActiveAt: 0,
      createdAt: 0,
    },
    {
      id: 'thread-2',
      title: 'Thread 2',
      projectPath: 'p',
      createdBy: 'u',
      participants: [],
      lastActiveAt: 0,
      createdAt: 0,
    },
  ],
  splitPaneThreadIds: ['thread-1', 'thread-2'],
  splitPaneTargetId: 'thread-2',
  setSplitPaneTarget: vi.fn(),
  setSplitPaneThreadIds: vi.fn(),
  getThreadState: () => ({
    messages: [],
    isLoading: false,
    isLoadingHistory: false,
    hasMore: true,
    hasActiveInvocation: false,
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

vi.mock('@/components/SplitPaneCell', () => ({
  SplitPaneCell: () => React.createElement('div'),
  SplitPanePlaceholder: () => React.createElement('div'),
}));

vi.mock('@/components/MiniThreadSidebar', () => ({
  MiniThreadSidebar: () => React.createElement('div'),
}));

// Mock ChatInput to render a button that triggers onSend when clicked
vi.mock('@/components/ChatInput', () => ({
  ChatInput: (props: { onSend: (c: string) => void; disabled: boolean }) => {
    return React.createElement(
      'button',
      {
        'data-testid': 'send-btn',
        onClick: () => props.onSend('test message'),
      },
      'Send',
    );
  },
}));

import { SplitPaneView } from '@/components/SplitPaneView';

describe('SplitPaneView input routing (P1-1)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
  });

  beforeEach(() => {
    mockOnSend.mockClear();
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

  it('onSend prop receives splitPaneTargetId as overrideThreadId', () => {
    act(() => {
      root.render(
        React.createElement(SplitPaneView, {
          onSend: mockOnSend,
          onStop: vi.fn(),
          onZoomToThread: vi.fn(),
        }),
      );
    });

    // Click the send button rendered by ChatInput mock
    const btn = container.querySelector('[data-testid="send-btn"]');
    expect(btn).toBeTruthy();

    act(() => {
      (btn as HTMLElement).click();
    });

    // SplitPaneView wraps onSend: (content, images, whisper, deliveryMode, replyToId) => onSend(content, images, splitPaneTargetId, whisper, deliveryMode, replyToId)
    expect(mockOnSend).toHaveBeenCalledWith('test message', undefined, 'thread-2', undefined, undefined, undefined);
  });
});
