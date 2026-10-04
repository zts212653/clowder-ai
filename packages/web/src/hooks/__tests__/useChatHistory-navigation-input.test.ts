import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import type { ChatMessage, ThreadState } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CHAT_LAYOUT_CHANGED_EVENT } from '@/utils/chat-layout-change';
import { readChatScrollState, saveChatScrollState } from '@/utils/chat-scroll-memory';
import { __resetPendingTeleportForTest } from '@/utils/teleport';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

let capturedHook: ReturnType<typeof useChatHistory> | null = null;

function HookProbe({ threadId }: { threadId: string }) {
  capturedHook = useChatHistory(threadId);
  return React.createElement(
    'div',
    { ref: capturedHook.scrollContainerRef },
    React.createElement('div', { ref: capturedHook.messagesEndRef }),
  );
}

function HookHost({ threadId }: { threadId: string }) {
  return React.createElement(ThreadChatHistoryAdmissionProvider, null, React.createElement(HookProbe, { threadId }));
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

describe('useChatHistory navigation input owner', () => {
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

  function beginGesture() {
    const gesture = capturedHook!.beginUserScroll();
    expect(gesture).not.toBeNull();
    return gesture!;
  }
  function jump(messageId: string) {
    return capturedHook!.jumpToMessage(messageId);
  }
  async function openThread(threadId: string) {
    const messages = [makeMsg('first', 1), makeMsg('second', 2)];
    useChatStore.setState({
      currentThreadId: threadId,
      messages,
      hasMore: false,
      isLoadingHistory: false,
      threadStates: { [threadId]: makeThreadState(messages) },
    });
    await act(async () => root.render(React.createElement(HookHost, { threadId })));
    const el = capturedHook!.scrollContainerRef.current!;
    const top = defineMutableNumberProp(el, 'scrollTop', 600);
    defineMutableNumberProp(el, 'scrollHeight', 1200);
    defineMutableNumberProp(el, 'clientHeight', 600);
    el.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    appendMessageBoundary(el, 'first', () => ({ top: 100 - top.get(), bottom: 500 - top.get() }));
    const second = appendMessageBoundary(el, 'second', () => ({ top: 500 - top.get(), bottom: 1300 - top.get() }));
    capturedHook!.messagesEndRef.current!.scrollIntoView = vi.fn();
    saveChatScrollState(threadId, { top: 600, anchor: 'bottom' });
    return { el, top, second };
  }

  it('records every rail movement as new reading input and re-enters bottom follow', async () => {
    const threadId = 'rail-movement';
    const { top } = await openThread(threadId);
    const gesture = beginGesture();
    act(() => {
      gesture.scrollTo(200);
      flushAnimationFrames();
    });
    expect(top.get()).toBe(200);
    expect(readChatScrollState(threadId)).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'first', viewportOffsetPx: -200 },
    });
    act(() => gesture.scrollTo(500));
    expect(readChatScrollState(threadId)).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'second', viewportOffsetPx: -100 },
    });
    act(() => gesture.scrollTo(600));
    expect(readChatScrollState(threadId)).toEqual({ top: 600, anchor: 'bottom' });
    const end = capturedHook!.messagesEndRef.current!;
    end.scrollIntoView = vi.fn();
    act(() => useChatStore.getState().addMessage(makeMsg('appended', 3)));
    expect(end.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' });
  });

  it('rejects stale rail callbacks after an explicit message jump', async () => {
    const threadId = 'rail-versus-jump';
    const { top, second } = await openThread(threadId);
    const gesture = beginGesture();
    const target = second.querySelector<HTMLElement>('[data-message-id]')!;
    target.scrollIntoView = vi.fn(() => top.set(350));
    act(() => {
      gesture.scrollTo(200);
      jump('second');
      flushAnimationFrames();
    });
    expect(gesture.scrollTo(150)).toBe(false);
    act(() => {
      for (let n = 0; n < 4; n++) flushAnimationFrames();
    });
    expect(top.get()).toBe(350);
    expect(readChatScrollState(threadId)).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'second', viewportOffsetPx: 50 },
    });
  });

  it('waits for the last one-pixel animation frames before saving a message jump', async () => {
    const threadId = 'navigation-final-pixels';
    const { top, second } = await openThread(threadId);
    second.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = vi.fn(() => top.set(355));
    act(() => {
      jump('second');
      flushAnimationFrames();
      for (const frameTop of [355, 354, 353, 352, 351, 350]) {
        top.set(frameTop);
        flushAnimationFrames();
        capturedHook!.handleScroll();
      }
      for (let n = 0; n < 3; n++) flushAnimationFrames();
    });
    expect(readChatScrollState(threadId)).toMatchObject({
      top: 350,
      anchor: 'offset',
      messageAnchor: { messageId: 'second', viewportOffsetPx: 50 },
    });
  });

  it('rejects a gesture after switching away and Back to the same thread', async () => {
    const threadId = 'rail-generation';
    const { top } = await openThread(threadId);
    const gesture = beginGesture();
    await act(async () => root.render(React.createElement(HookHost, { threadId: 'another-thread' })));
    await act(async () => root.render(React.createElement(HookHost, { threadId })));
    top.set(500);
    expect(gesture.scrollTo(150)).toBe(false);
    expect(top.get()).toBe(500);
  });

  it('bounds real user input and ignores non-finite coordinates without moving the viewport', async () => {
    const { top } = await openThread('rail-bounds');
    const gesture = beginGesture();
    act(() => gesture.scrollTo(-500));
    expect(top.get()).toBe(0);
    act(() => gesture.scrollTo(5000));
    expect(top.get()).toBe(600);
    for (const invalid of [NaN, Infinity, -Infinity]) expect(gesture.scrollTo(invalid)).toBe(false);
    expect(top.get()).toBe(600);
  });

  it('lets an ongoing gesture preempt a layout correction without invalidating the gesture', async () => {
    const { top } = await openThread('rail-layout-correction');
    const gesture = beginGesture();
    act(() => gesture.scrollTo(200));
    act(() => window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT)));
    expect(rafCallbacks.size).toBeGreaterThan(0);
    act(() => {
      expect(gesture.scrollTo(500)).toBe(true);
      flushAnimationFrames();
    });
    expect(top.get()).toBe(500);
    gesture.end();
    expect(gesture.scrollTo(200)).toBe(false);
  });

  it('keeps explicit message jumps scoped to their surface and writes the settled target', async () => {
    const threadId = 'navigation-surface';
    const decoy = document.createElement('div');
    decoy.dataset.messageId = 'second';
    decoy.scrollIntoView = vi.fn();
    document.body.prepend(decoy);
    try {
      const { top, second } = await openThread(threadId);
      const target = second.querySelector<HTMLElement>('[data-message-id]')!;
      target.scrollIntoView = vi.fn(() => top.set(350));
      act(() => {
        jump('second');
        for (let n = 0; n < 5; n++) flushAnimationFrames();
      });
      expect(decoy.scrollIntoView).not.toHaveBeenCalled();
      expect(target.scrollIntoView).toHaveBeenCalledOnce();
      expect(readChatScrollState(threadId)).toMatchObject({
        top: 350,
        anchor: 'offset',
        messageAnchor: { messageId: 'second', viewportOffsetPx: 50 },
      });
    } finally {
      decoy.remove();
    }
  });

  it('lets an inactive surface navigate locally without changing its reading record', async () => {
    const { top, second } = await openThread('inactive-navigation');
    const before = readChatScrollState('inactive-navigation');
    act(() => useChatStore.getState().setCurrentThread('active-navigation'));
    const gesture = beginGesture();
    act(() => gesture.scrollTo(200));
    expect(top.get()).toBe(200);
    second.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = vi.fn(() => top.set(350));
    act(() => expect(jump('second')).toBe(true));
    expect(top.get()).toBe(350);
    expect(gesture.scrollTo(100)).toBe(false);
    expect(readChatScrollState('inactive-navigation')).toEqual(before);
  });

  it('rejects callbacks from an unmounted surface', async () => {
    const { top } = await openThread('unmounted-navigation');
    const gesture = beginGesture();
    const oldJump = capturedHook!.jumpToMessage;
    act(() => root.render(null));
    expect(gesture.scrollTo(200)).toBe(false);
    expect(oldJump('second')).toBe(false);
    expect(top.get()).toBe(600);
  });
});
