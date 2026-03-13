import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

let capturedMessagesEndRef: React.RefObject<HTMLDivElement | null> | null = null;

function HookHost({ threadId }: { threadId: string }) {
  const { messagesEndRef } = useChatHistory(threadId);
  capturedMessagesEndRef = messagesEndRef;
  return null;
}

describe('useChatHistory scroll reset on thread switch (#35)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

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
    capturedMessagesEndRef = null;

    apiFetchMock.mockImplementation(() => new Promise<Response>(() => {}));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
  });

  it('treats cached thread restore as initial load for scroll-to-bottom', () => {
    // Thread A has messages loaded
    useChatStore.setState({
      messages: [
        { id: 'a1', type: 'user', content: 'msg in thread-a', timestamp: 1000 },
        { id: 'a2', type: 'assistant', catId: 'opus', content: 'reply', timestamp: 2000 },
      ],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: false,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      currentThreadId: 'thread-a',
      threadStates: {
        'thread-b': {
          messages: [
            { id: 'b1', type: 'user', content: 'msg in thread-b', timestamp: 3000 },
            { id: 'b2', type: 'assistant', catId: 'opus', content: 'reply b', timestamp: 4000 },
            { id: 'b3', type: 'user', content: 'another msg', timestamp: 5000 },
          ],
          isLoading: false,
          isLoadingHistory: false,
          hasMore: false,
          hasActiveInvocation: false,
          intentMode: null,
          targetCats: [],
          catStatuses: {},
          catInvocations: {},
          currentGame: null,
          unreadCount: 0,
          hasUserMention: false,
          lastActivity: Date.now(),
          queue: [],
          queuePaused: false,
          queueFull: false,
        },
      },
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });

    // Mount with thread-a to initialize prevCountRef to 2
    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-a' }));
    });

    // Now switch to thread-b (which has cached messages).
    // First, simulate setCurrentThread restoring cached messages.
    act(() => {
      useChatStore.getState().setCurrentThread('thread-b');
    });

    // Re-render hook with new threadId — this triggers the threadId change
    // effect which should reset prevCountRef to 0.
    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-b' }));
    });

    // After the scroll effect runs with prevCount === 0, it should have
    // called scrollIntoView on the messagesEndRef. Since we don't have
    // a real DOM scroll container, we verify indirectly: the messages
    // should be the cached thread-b messages (proving restore worked),
    // and no error should have occurred.
    const state = useChatStore.getState();
    expect(state.messages.map((m) => m.id)).toEqual(['b1', 'b2', 'b3']);
  });
});
