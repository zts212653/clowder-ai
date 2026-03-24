import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ThreadState } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

let capturedHook: ReturnType<typeof useChatHistory> | null = null;

function HookHost({ threadId }: { threadId: string }) {
  capturedHook = useChatHistory(threadId);
  return React.createElement(
    'div',
    { ref: capturedHook.scrollContainerRef },
    React.createElement('div', { ref: capturedHook.messagesEndRef }),
  );
}

function makeMsg(id: string, timestamp: number): ChatMessage {
  return { id, type: 'assistant', catId: 'opus', content: id, timestamp };
}

function makeThreadState(messages: ChatMessage[]): ThreadState {
  return {
    messages,
    isLoading: false,
    isLoadingHistory: false,
    hasMore: false,
    hasActiveInvocation: false,
    activeInvocations: {},
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
  };
}

function defineMutableNumberProp(target: object, key: string, initial: number) {
  let current = initial;
  Object.defineProperty(target, key, {
    configurable: true,
    get: () => current,
    set: (next: number) => {
      current = next;
    },
  });
  return {
    get: () => current,
    set: (next: number) => {
      current = next;
    },
  };
}

describe('useChatHistory scroll memory (#27)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);
  const rafCallbacks = new Map<number, FrameRequestCallback>();
  let nextRafId = 1;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    capturedHook = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    rafCallbacks.clear();
    nextRafId = 1;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      rafCallbacks.delete(id);
    }) as typeof cancelAnimationFrame;

    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], tasks: [], hasMore: false }),
    } as Response);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  });

  function flushAnimationFrames(time = 16) {
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks.clear();
    for (const cb of callbacks) cb(time);
  }

  it('retries saved offset restore until the remounted thread becomes scrollable again', async () => {
    const threadA = 'thread-scroll-a';
    const threadB = 'thread-scroll-b';
    const aMessages = [makeMsg('a1', 1), makeMsg('a2', 2), makeMsg('a3', 3)];
    const bMessages = [makeMsg('b1', 4)];

    useChatStore.setState({
      currentThreadId: threadA,
      messages: aMessages,
      hasMore: false,
      isLoadingHistory: false,
      threadStates: {
        [threadA]: makeThreadState(aMessages),
        [threadB]: makeThreadState(bMessages),
      },
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: threadA }));
    });

    const firstScrollEl = capturedHook!.scrollContainerRef.current!;
    const firstTop = defineMutableNumberProp(firstScrollEl, 'scrollTop', 0);
    defineMutableNumberProp(firstScrollEl, 'clientHeight', 600);
    defineMutableNumberProp(firstScrollEl, 'scrollHeight', 971);

    // Ignore the mount-time bottom-anchor restore; this test is about the saved offset path.
    rafCallbacks.clear();

    firstTop.set(200);
    act(() => {
      capturedHook?.handleScroll();
    });

    act(() => {
      root.unmount();
    });
    container.remove();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useChatStore.setState({
      currentThreadId: threadB,
      messages: bMessages,
      hasMore: false,
      isLoadingHistory: false,
      threadStates: {
        [threadA]: makeThreadState(aMessages),
        [threadB]: makeThreadState(bMessages),
      },
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: threadA }));
    });

    const remountScrollEl = capturedHook!.scrollContainerRef.current!;
    const remountTop = defineMutableNumberProp(remountScrollEl, 'scrollTop', 0);
    defineMutableNumberProp(remountScrollEl, 'clientHeight', 600);
    const remountHeight = defineMutableNumberProp(remountScrollEl, 'scrollHeight', 600);

    act(() => {
      useChatStore.getState().setCurrentThread(threadA);
    });

    // Layout is still too short during the first restore attempt.
    expect(rafCallbacks.size).toBeGreaterThan(0);

    remountHeight.set(971);
    act(() => {
      flushAnimationFrames();
    });

    expect(remountTop.get()).toBe(200);
  });

  it('does not auto-scroll on append when the user is reading above the bottom', async () => {
    const threadId = 'thread-append-offset';
    const messages = [makeMsg('m1', 1), makeMsg('m2', 2)];

    useChatStore.setState({
      currentThreadId: threadId,
      messages,
      hasMore: false,
      isLoadingHistory: false,
      threadStates: {
        [threadId]: makeThreadState(messages),
      },
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId }));
    });

    const scrollEl = capturedHook!.scrollContainerRef.current!;
    const scrollTop = defineMutableNumberProp(scrollEl, 'scrollTop', 200);
    defineMutableNumberProp(scrollEl, 'clientHeight', 600);
    defineMutableNumberProp(scrollEl, 'scrollHeight', 1000);
    const endEl = capturedHook!.messagesEndRef.current!;
    endEl.scrollIntoView = vi.fn(() => {
      scrollTop.set(400);
    });

    rafCallbacks.clear();

    act(() => {
      capturedHook?.handleScroll();
    });

    act(() => {
      useChatStore.setState({
        messages: [...messages, makeMsg('m3', 3)],
      });
    });

    expect(endEl.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTop.get()).toBe(200);
  });

  it('keeps auto-following appended messages when the user was already at bottom', async () => {
    const threadId = 'thread-append-bottom';
    const messages = [makeMsg('m1', 1), makeMsg('m2', 2)];

    useChatStore.setState({
      currentThreadId: threadId,
      messages,
      hasMore: false,
      isLoadingHistory: false,
      threadStates: {
        [threadId]: makeThreadState(messages),
      },
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId }));
    });

    const scrollEl = capturedHook!.scrollContainerRef.current!;
    const scrollTop = defineMutableNumberProp(scrollEl, 'scrollTop', 400);
    defineMutableNumberProp(scrollEl, 'clientHeight', 600);
    defineMutableNumberProp(scrollEl, 'scrollHeight', 1000);
    const endEl = capturedHook!.messagesEndRef.current!;
    endEl.scrollIntoView = vi.fn(() => {
      scrollTop.set(500);
    });

    rafCallbacks.clear();

    act(() => {
      capturedHook?.handleScroll();
    });

    act(() => {
      useChatStore.setState({
        messages: [...messages, makeMsg('m3', 3)],
      });
    });

    expect(endEl.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' });
    expect(scrollTop.get()).toBe(500);
  });
});
