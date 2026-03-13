import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

/**
 * Host component that mirrors the real ChatContainer pattern:
 * 1. useChatHistory(threadId) — registers scroll effects first
 * 2. useEffect with setCurrentThread — restores cached messages second
 *
 * This ordering is critical: in the real app, useChatHistory's effects
 * fire before ChatContainer's setCurrentThread effect.
 */
function RealisticHost({ threadId }: { threadId: string }) {
  const { messagesEndRef } = useChatHistory(threadId);

  // Simulate ChatContainer's setCurrentThread effect (fires AFTER useChatHistory effects)
  const prevThreadRef = React.useRef(threadId);
  React.useEffect(() => {
    if (prevThreadRef.current !== threadId) {
      useChatStore.getState().setCurrentThread(threadId);
      prevThreadRef.current = threadId;
    }
    useChatStore.getState().setCurrentThread(threadId);
  }, [threadId]);

  return React.createElement('div', { ref: messagesEndRef });
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
    apiFetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    // jsdom does not implement scrollIntoView — stub it globally
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
  });

  it('scrolls to bottom after setCurrentThread restores cached messages', () => {
    // Setup: thread-a is active with 2 messages, thread-b has cached 3 messages
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

    // Mount with thread-a — this initializes prevCountRef to 2
    act(() => {
      root.render(React.createElement(RealisticHost, { threadId: 'thread-a' }));
    });

    // Spy on scrollIntoView on the end sentinel div (messagesEndRef target).
    // Record the currentThreadId at each call to prove scroll fires on the right thread.
    const endDiv = container.querySelector('div');
    const callThreadIds: string[] = [];
    const scrollSpy = vi.fn(() => {
      callThreadIds.push(useChatStore.getState().currentThreadId);
    });
    if (endDiv) endDiv.scrollIntoView = scrollSpy;

    // Switch to thread-b — this triggers the real sequence:
    // Render 1: effects fire in hook declaration order:
    //   1. useChatHistory threadId effect → sets scrollToBottomRef = true
    //   2. useChatHistory scroll effect → messages still from thread-a → scrollToBottomRef consumed
    //      BUT wrong messages; or if messages.length=0 (clearMessages ran), skip
    //   3. RealisticHost setCurrentThread effect → restores cached thread-b messages
    // Render 2 (triggered by state change from setCurrentThread):
    //   4. useChatHistory scroll effect → scrollToBottomRef was consumed in step 2...
    //
    // With the scrollToBottomRef fix, even if step 2 fires prematurely,
    // the flag persists across renders and triggers scroll on the correct render.
    act(() => {
      root.render(React.createElement(RealisticHost, { threadId: 'thread-b' }));
    });

    // Verify messages are now thread-b's cached messages
    const state = useChatStore.getState();
    expect(state.messages.map((m) => m.id)).toEqual(['b1', 'b2', 'b3']);

    // Verify scrollIntoView was called (proving scroll-to-bottom fired)
    expect(scrollSpy).toHaveBeenCalled();

    // Critical: verify that EVERY scrollIntoView call happened while the
    // store was synced to thread-b (the target thread), not on stale thread-a data.
    // This is the core invariant: scroll must not fire before setCurrentThread restores
    // the correct messages.
    expect(callThreadIds.length).toBeGreaterThan(0);
    for (const tid of callThreadIds) {
      expect(tid).toBe('thread-b');
    }
  });
});
