/**
 * P1 regression: split-pane Stop button should cancel the selected pane's thread,
 * not the URL threadId.
 *
 * Red test: verifies that SplitPaneView passes splitPaneTargetId to onStop.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExplicitStopIntent } from '@/hooks/useSocket-cancel-provenance';

const mockOnStop = vi.fn();

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
  ChatInput: ({ onStop }: { onStop?: (intent: ExplicitStopIntent) => void }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'stop-btn',
        onClick: () => onStop?.({ sourceControl: 'chat_input_action', gesture: 'pointer', trustedGesture: true }),
      },
      'Stop',
    ),
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
    mockOnStop.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('passes splitPaneTargetId to onStop, not the URL threadId', () => {
    act(() => {
      root.render(
        React.createElement(SplitPaneView, {
          onSend: vi.fn(),
          onStop: mockOnStop,
          onZoomToThread: vi.fn(),
        }),
      );
    });

    const stopBtn = container.querySelector('[data-testid="stop-btn"]');
    expect(stopBtn).toBeTruthy();

    act(() => {
      stopBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // P1 regression: onStop should be called with the target thread ID (thread-b),
    // NOT with no args (which would default to URL threadId in ChatContainer)
    expect(mockOnStop).toHaveBeenCalledWith(
      { sourceControl: 'chat_input_action', gesture: 'pointer', trustedGesture: true },
      'thread-b',
    );
  });
});
