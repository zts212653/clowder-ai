import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ThreadState } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { MESSAGE_VIEWPORT_MOUNTED_EVENT, MOUNT_DEFERRED_MESSAGE_EVENT } from '@/utils/scrollToMessage';
import { __resetPendingTeleportForTest, setPendingTeleport } from '@/utils/teleport';
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
    catStatusDetails: {},
    catInvocations: {},
    currentGame: null,
    unreadCount: 0,
    hasUserMention: false,
    lastActivity: Date.now(),
    queue: [],
    queuePaused: false,
    queueFull: false,
    workspaceWorktreeId: null,
    workspaceOpenTabs: [],
    workspaceOpenFilePath: null,
    workspaceOpenFileLine: null,
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
    __resetPendingTeleportForTest();
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
  });

  function flushAnimationFrames(time = 16) {
    const callbacks = [...rafCallbacks.values()];
    rafCallbacks.clear();
    for (const cb of callbacks) cb(time);
  }

  function cancelInitialRestoreWithWheel(scrollEl: HTMLElement, deltaY: number) {
    act(() => scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY })));
    rafCallbacks.clear();
  }

  function appendMessageBoundary(
    scrollEl: HTMLElement,
    messageId: string,
    rect: () => Pick<DOMRect, 'top' | 'bottom'>,
  ) {
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = messageId;
    boundary.getBoundingClientRect = () => rect() as DOMRect;
    const message = document.createElement('div');
    message.dataset.messageId = messageId;
    boundary.appendChild(message);
    scrollEl.appendChild(boundary);
    return boundary;
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
    cancelInitialRestoreWithWheel(firstScrollEl, -1);

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

  it('keeps the same message-relative position while deferred predecessors change height', async () => {
    const threadA = 'thread-message-anchor-a';
    const threadB = 'thread-message-anchor-b';
    const aMessages = [makeMsg('anchor-message', 1), makeMsg('tail-message', 2)];
    const bMessages = [makeMsg('other-message', 3)];

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
    await act(async () => root.render(React.createElement(HookHost, { threadId: threadA })));

    const firstScrollEl = capturedHook!.scrollContainerRef.current!;
    const firstTop = defineMutableNumberProp(firstScrollEl, 'scrollTop', 200);
    defineMutableNumberProp(firstScrollEl, 'clientHeight', 600);
    defineMutableNumberProp(firstScrollEl, 'scrollHeight', 1000);
    firstScrollEl.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    appendMessageBoundary(firstScrollEl, 'anchor-message', () => ({ top: 80, bottom: 260 }));
    cancelInitialRestoreWithWheel(firstScrollEl, -1);
    act(() => capturedHook?.handleScroll());

    act(() => root.unmount());
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
    await act(async () => root.render(React.createElement(HookHost, { threadId: threadA })));

    const restoredEl = capturedHook!.scrollContainerRef.current!;
    const restoredTop = defineMutableNumberProp(restoredEl, 'scrollTop', 0);
    defineMutableNumberProp(restoredEl, 'clientHeight', 600);
    const restoredHeight = defineMutableNumberProp(restoredEl, 'scrollHeight', 1200);
    restoredEl.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    let anchorContentTop = 580;
    appendMessageBoundary(restoredEl, 'anchor-message', () => ({
      top: 100 + anchorContentTop - restoredTop.get(),
      bottom: 280 + anchorContentTop - restoredTop.get(),
    }));

    act(() => useChatStore.getState().setCurrentThread(threadA));
    act(() => flushAnimationFrames());
    expect(restoredTop.get()).toBe(600);

    anchorContentTop = 780;
    restoredHeight.set(1400);
    act(() => {
      window.dispatchEvent(new CustomEvent(MESSAGE_VIEWPORT_MOUNTED_EVENT, { detail: { messageId: 'predecessor' } }));
      flushAnimationFrames();
    });

    expect(restoredTop.get()).toBe(800);
    expect(100 + anchorContentTop - restoredTop.get()).toBe(80);
    firstTop.set(200);
  });

  it('falls back once to the saved pixel offset when the message anchor is absent', async () => {
    const threadA = 'thread-missing-anchor-a';
    const threadB = 'thread-missing-anchor-b';
    const aMessages = [makeMsg('missing-anchor', 1)];
    const bMessages = [makeMsg('other-message', 2)];
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
    await act(async () => root.render(React.createElement(HookHost, { threadId: threadA })));

    const firstScrollEl = capturedHook!.scrollContainerRef.current!;
    const firstTop = defineMutableNumberProp(firstScrollEl, 'scrollTop', 200);
    defineMutableNumberProp(firstScrollEl, 'clientHeight', 600);
    defineMutableNumberProp(firstScrollEl, 'scrollHeight', 1000);
    firstScrollEl.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    appendMessageBoundary(firstScrollEl, 'missing-anchor', () => ({ top: 80, bottom: 260 }));
    cancelInitialRestoreWithWheel(firstScrollEl, -1);
    act(() => capturedHook?.handleScroll());

    act(() => root.unmount());
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
    await act(async () => root.render(React.createElement(HookHost, { threadId: threadA })));

    const restoredEl = capturedHook!.scrollContainerRef.current!;
    const restoredTop = defineMutableNumberProp(restoredEl, 'scrollTop', 0);
    defineMutableNumberProp(restoredEl, 'clientHeight', 600);
    defineMutableNumberProp(restoredEl, 'scrollHeight', 1000);
    restoredEl.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    act(() => useChatStore.getState().setCurrentThread(threadA));
    act(() => flushAnimationFrames());

    expect(restoredTop.get()).toBe(200);
    expect(rafCallbacks.size).toBe(1);
    act(() => flushAnimationFrames());
    expect(rafCallbacks.size).toBe(0);
    expect(restoredTop.get()).toBe(200);
    firstTop.set(200);
  });

  it('ignores a stale message-anchor correction after switching threads', async () => {
    const threadA = 'thread-stale-anchor-a';
    const threadB = 'thread-stale-anchor-b';
    const aMessages = [makeMsg('anchor-message', 1)];
    const bMessages = [makeMsg('other-message', 2)];
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
    await act(async () => root.render(React.createElement(HookHost, { threadId: threadA })));

    const scrollEl = capturedHook!.scrollContainerRef.current!;
    const scrollTop = defineMutableNumberProp(scrollEl, 'scrollTop', 200);
    defineMutableNumberProp(scrollEl, 'clientHeight', 600);
    defineMutableNumberProp(scrollEl, 'scrollHeight', 1000);
    scrollEl.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    appendMessageBoundary(scrollEl, 'anchor-message', () => ({ top: 80, bottom: 260 }));
    cancelInitialRestoreWithWheel(scrollEl, -1);
    act(() => capturedHook?.handleScroll());
    act(() => {
      window.dispatchEvent(new CustomEvent(MESSAGE_VIEWPORT_MOUNTED_EVENT, { detail: { messageId: 'predecessor' } }));
    });
    const staleCorrection = [...rafCallbacks.values()][0];
    expect(staleCorrection).toBeDefined();

    await act(async () => {
      useChatStore.getState().setCurrentThread(threadB);
      root.render(React.createElement(HookHost, { threadId: threadB }));
      await Promise.resolve();
    });
    scrollTop.set(75);
    act(() => staleCorrection?.(32));

    expect(scrollTop.get()).toBe(75);
  });

  it('lets user input preempt a queued message-anchor layout correction', async () => {
    const threadId = 'thread-message-anchor-input';
    const messages = [makeMsg('anchor-message', 1)];
    useChatStore.setState({
      currentThreadId: threadId,
      messages,
      hasMore: false,
      isLoadingHistory: false,
      threadStates: { [threadId]: makeThreadState(messages) },
    });
    await act(async () => root.render(React.createElement(HookHost, { threadId })));

    const scrollEl = capturedHook!.scrollContainerRef.current!;
    const scrollTop = defineMutableNumberProp(scrollEl, 'scrollTop', 200);
    defineMutableNumberProp(scrollEl, 'clientHeight', 600);
    defineMutableNumberProp(scrollEl, 'scrollHeight', 1200);
    scrollEl.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    appendMessageBoundary(scrollEl, 'anchor-message', () => ({ top: 80, bottom: 260 }));
    cancelInitialRestoreWithWheel(scrollEl, -1);
    act(() => capturedHook?.handleScroll());

    act(() => {
      window.dispatchEvent(new CustomEvent(MESSAGE_VIEWPORT_MOUNTED_EVENT, { detail: { messageId: 'predecessor' } }));
    });
    expect(rafCallbacks.size).toBeGreaterThan(0);

    act(() => {
      scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
      scrollTop.set(360);
      capturedHook?.handleScroll();
      flushAnimationFrames();
    });

    expect(scrollTop.get()).toBe(360);
  });

  it('does not let a deferred mount correction cancel explicit message navigation', async () => {
    const threadId = 'thread-explicit-navigation-priority';
    const targetId = 'deferred-navigation-target';
    const messages = [makeMsg(targetId, 1)];
    useChatStore.setState({
      currentThreadId: threadId,
      messages,
      hasMore: false,
      isLoadingHistory: false,
      threadStates: { [threadId]: makeThreadState(messages) },
    });
    setPendingTeleport({ threadId, messageId: targetId });
    await act(async () => root.render(React.createElement(HookHost, { threadId })));

    const scrollEl = capturedHook!.scrollContainerRef.current!;
    defineMutableNumberProp(scrollEl, 'scrollTop', 0);
    defineMutableNumberProp(scrollEl, 'clientHeight', 600);
    defineMutableNumberProp(scrollEl, 'scrollHeight', 1200);
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = targetId;
    boundary.dataset.deferredMessageId = targetId;
    const mountRequested = vi.fn();
    boundary.addEventListener(MOUNT_DEFERRED_MESSAGE_EVENT, mountRequested);
    scrollEl.appendChild(boundary);

    act(() => flushAnimationFrames());
    expect(mountRequested).toHaveBeenCalledOnce();

    const target = document.createElement('div');
    target.dataset.messageId = targetId;
    target.scrollIntoView = vi.fn();
    delete boundary.dataset.deferredMessageId;
    boundary.appendChild(target);
    act(() => {
      window.dispatchEvent(new CustomEvent(MESSAGE_VIEWPORT_MOUNTED_EVENT, { detail: { messageId: targetId } }));
      flushAnimationFrames();
    });

    expect(target.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('keeps the navigated message anchored while deferred predecessors mount', async () => {
    const threadId = 'thread-navigation-anchor-settle';
    const targetId = 'navigation-anchor-target';
    const messages = [makeMsg(targetId, 1)];
    useChatStore.setState({
      currentThreadId: threadId,
      messages,
      hasMore: false,
      isLoadingHistory: false,
      threadStates: { [threadId]: makeThreadState(messages) },
    });
    setPendingTeleport({ threadId, messageId: targetId });
    await act(async () => root.render(React.createElement(HookHost, { threadId })));

    const scrollEl = capturedHook!.scrollContainerRef.current!;
    const scrollTop = defineMutableNumberProp(scrollEl, 'scrollTop', 0);
    defineMutableNumberProp(scrollEl, 'clientHeight', 600);
    const scrollHeight = defineMutableNumberProp(scrollEl, 'scrollHeight', 1200);
    scrollEl.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    let targetContentTop = 650;
    const boundary = appendMessageBoundary(scrollEl, targetId, () => ({
      top: 100 + targetContentTop - scrollTop.get(),
      bottom: 280 + targetContentTop - scrollTop.get(),
    }));
    const target = boundary.querySelector<HTMLElement>('[data-message-id]');
    if (!target) throw new Error('expected mounted navigation target');
    target.scrollIntoView = vi.fn();

    act(() => {
      flushAnimationFrames();
      scrollTop.set(200);
      capturedHook?.handleScroll();
      flushAnimationFrames();
      scrollTop.set(450);
      capturedHook?.handleScroll();
      flushAnimationFrames();
      scrollTop.set(600);
      capturedHook?.handleScroll();
      flushAnimationFrames();
      flushAnimationFrames();
      flushAnimationFrames();
    });
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    expect(boundary.getBoundingClientRect().top).toBe(150);

    targetContentTop += 200;
    scrollHeight.set(1400);
    act(() => {
      window.dispatchEvent(new CustomEvent(MESSAGE_VIEWPORT_MOUNTED_EVENT, { detail: { messageId: 'predecessor' } }));
      flushAnimationFrames();
    });

    expect(scrollTop.get()).toBe(800);
    expect(boundary.getBoundingClientRect().top).toBe(150);
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

    cancelInitialRestoreWithWheel(scrollEl, -1);

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

    cancelInitialRestoreWithWheel(scrollEl, 1);

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

  it('leaves bottom follow after repeated small user scroll-up inputs', async () => {
    const threadId = 'thread-small-user-scrolls';
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
    const scrollHeight = defineMutableNumberProp(scrollEl, 'scrollHeight', 1000);
    const endEl = capturedHook!.messagesEndRef.current!;
    endEl.scrollIntoView = vi.fn();

    cancelInitialRestoreWithWheel(scrollEl, 1);
    act(() => {
      capturedHook?.handleScroll();
    });

    scrollHeight.set(1400);
    for (const top of [398, 396, 394, 392, 390]) {
      act(() => {
        scrollEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -2 }));
        scrollTop.set(top);
        capturedHook?.handleScroll();
      });
    }

    act(() => {
      useChatStore.setState({
        messages: [...messages, makeMsg('m3', 3)],
      });
    });

    expect(endEl.scrollIntoView).not.toHaveBeenCalled();
  });

  it('keeps bottom follow across a layout-driven upward scroll correction', async () => {
    const threadId = 'thread-layout-upward-correction';
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
    const scrollTop = defineMutableNumberProp(scrollEl, 'scrollTop', 500);
    defineMutableNumberProp(scrollEl, 'clientHeight', 600);
    const scrollHeight = defineMutableNumberProp(scrollEl, 'scrollHeight', 1100);
    const endEl = capturedHook!.messagesEndRef.current!;
    endEl.scrollIntoView = vi.fn();

    cancelInitialRestoreWithWheel(scrollEl, 1);
    act(() => {
      capturedHook?.handleScroll();
    });

    scrollHeight.set(1400);
    scrollTop.set(450);
    act(() => {
      capturedHook?.handleScroll();
    });

    act(() => {
      useChatStore.setState({
        messages: [...messages, makeMsg('m3', 3)],
      });
    });

    expect(endEl.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('keeps following when smooth-scroll intermediate frames fire scroll events (clowder-ai#1234)', async () => {
    const threadId = 'thread-append-smooth-frames';
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
    const scrollHeight = defineMutableNumberProp(scrollEl, 'scrollHeight', 1000);
    const endEl = capturedHook!.messagesEndRef.current!;
    const scrollIntoView = vi.fn();
    endEl.scrollIntoView = scrollIntoView;

    cancelInitialRestoreWithWheel(scrollEl, 1);

    act(() => {
      capturedHook?.handleScroll();
    });

    scrollHeight.set(1600);
    act(() => {
      useChatStore.setState({
        messages: [...messages, makeMsg('m3', 3)],
      });
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    scrollTop.set(500);
    act(() => {
      capturedHook?.handleScroll();
    });

    act(() => {
      useChatStore.setState({
        messages: [...messages, makeMsg('m3', 3), makeMsg('m4', 4)],
      });
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('keeps bottom anchor on layout-change events when the user is pinned to bottom', async () => {
    const threadId = 'thread-layout-bottom';
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
      scrollTop.set(460);
    });

    cancelInitialRestoreWithWheel(scrollEl, 1);

    act(() => {
      capturedHook?.handleScroll();
    });

    act(() => {
      window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
      flushAnimationFrames();
    });

    expect(endEl.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto' });
    expect(scrollTop.get()).toBe(460);
  });

  it('does not hijack scroll on layout-change events when the user is reading above the bottom', async () => {
    const threadId = 'thread-layout-offset';
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
      scrollTop.set(460);
    });

    cancelInitialRestoreWithWheel(scrollEl, -1);

    act(() => {
      capturedHook?.handleScroll();
    });

    act(() => {
      window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
      flushAnimationFrames();
    });

    expect(endEl.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTop.get()).toBe(200);
  });
});
