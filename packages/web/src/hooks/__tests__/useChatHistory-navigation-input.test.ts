import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HtmlWidgetBlock } from '@/components/rich/HtmlWidgetBlock';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import type { ChatMessage, ThreadState } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CHAT_LAYOUT_CHANGED_EVENT } from '@/utils/chat-layout-change';
import {
  __resetChatScrollMemoryForTest,
  captureChatReadingRef,
  readChatReadingRef,
  readChatScrollState,
  saveChatScrollState,
} from '@/utils/chat-scroll-memory';
import { MESSAGE_VIEWPORT_MOUNTED_EVENT } from '@/utils/scrollToMessage';
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
    unreadCount: 0,
    hasUserMention: false,
    lastActivity: Date.now(),
    queue: [],
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

  it('captures the actual surface reading point and restores it only after owner settlement', async () => {
    const { top } = await openThread('search-reading-return');
    const gesture = beginGesture();
    act(() => {
      gesture.scrollTo(200);
      gesture.end();
    });
    expect(capturedHook!.captureReadingPosition).toBeTypeOf('function');
    const snapshot = capturedHook!.captureReadingPosition();
    expect(snapshot).toMatchObject({
      threadId: 'search-reading-return',
      position: {
        top: 200,
        anchor: 'offset',
        messageAnchor: { messageId: 'first', viewportOffsetPx: -200, timelineOrderAt: 1 },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('content');
    const captured = capturedHook!.captureReadingRef()!;
    expect(captured.persisted).toBe(true);
    act(() => beginGesture().scrollTo(500));
    __resetChatScrollMemoryForTest();
    let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
    act(() => {
      receipt = capturedHook!.restoreReadingRef(captured.ref);
    });
    const settled = vi.fn();
    void receipt.then(settled);
    expect(settled).not.toHaveBeenCalled();
    await act(async () => {
      for (let n = 0; n < 5; n++) flushAnimationFrames();
      await receipt;
    });
    expect(top.get()).toBe(200);
    expect(await receipt).toMatchObject({ status: 'settled', exact: true });
    expect(readChatScrollState('search-reading-return')).toMatchObject({
      top: 200,
      anchor: 'offset',
      messageAnchor: { messageId: 'first', viewportOffsetPx: -200, timelineOrderAt: 1 },
    });
    expect(capturedHook!.releaseReadingRef(captured.ref)).toBe(true);
    expect(readChatReadingRef(captured.ref)).toBeUndefined();
  });

  it.each([2, 100])('keeps an older origin pending while its page takes %i frames', async (frames) => {
    const threadId = `return-slow-page-${frames}`;
    const { el, top } = await openThread(threadId);
    act(() => {
      const gesture = beginGesture();
      gesture.scrollTo(200);
      gesture.end();
    });
    const origin = capturedHook!.captureReadingRef()!;
    act(() => beginGesture().scrollTo(500));
    // Re-entering the origin after a cold route has only its latest page.
    const latest = [makeMsg('latest', 10)];
    saveChatScrollState(threadId, { top: 600, anchor: 'bottom' });
    act(() =>
      useChatStore.setState({
        messages: latest,
        hasMore: true,
        threadStates: { [threadId]: { ...makeThreadState(latest), hasMore: true } },
      }),
    );
    let resolvePage!: (value: Response) => void;
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [makeMsg('latest', 10)], hasMore: true }),
    } as Response);
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolvePage = resolve;
        }),
    );
    for (const node of el.querySelectorAll('[data-message-viewport-id]')) node.remove();
    appendMessageBoundary(el, 'latest', () => ({ top: 500 - top.get(), bottom: 1300 - top.get() }));
    let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingRef']>;
    await act(async () => {
      receipt = capturedHook!.restoreReadingRef(origin.ref, undefined, { refresh: true });
    });
    expect(resolvePage).toBeTypeOf('function');
    const settled = vi.fn();
    void receipt.then(settled);
    await act(async () => {
      for (let n = 0; n < frames; n++) flushAnimationFrames();
    });
    expect(settled).not.toHaveBeenCalled();
    expect(readChatReadingRef(origin.ref)?.position).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'first' },
    });
    await act(async () => {
      resolvePage({ ok: true, json: async () => ({ messages: [makeMsg('first', 1)], hasMore: false }) } as Response);
    });
    appendMessageBoundary(el, 'first', () => ({ top: 100 - top.get(), bottom: 500 - top.get() }));
    await act(async () => {
      for (let n = 0; n < 8; n++) flushAnimationFrames();
    });
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'settled', exact: true }));
    expect(top.get()).toBe(200);
    expect(readChatScrollState(threadId)).toMatchObject({ anchor: 'offset', messageAnchor: { messageId: 'first' } });
  });

  it('returns through multiple older pages without converting the origin to bottom', async () => {
    const threadId = 'return-multiple-pages';
    const { el, top } = await openThread(threadId);
    act(() => {
      const gesture = beginGesture();
      gesture.scrollTo(200);
      gesture.end();
    });
    const origin = capturedHook!.captureReadingRef()!;
    const latest = [makeMsg('latest', 10)];
    saveChatScrollState(threadId, { top: 600, anchor: 'bottom' });
    act(() =>
      useChatStore.setState({
        messages: latest,
        hasMore: true,
        threadStates: { [threadId]: { ...makeThreadState(latest), hasMore: true } },
      }),
    );
    for (const node of el.querySelectorAll('[data-message-viewport-id]')) node.remove();
    let firstPage!: (value: Response) => void;
    let secondPage!: (value: Response) => void;
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [makeMsg('latest', 10)], hasMore: true }),
    } as Response);
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          firstPage = resolve;
        }),
    );
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          secondPage = resolve;
        }),
    );
    let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingRef']>;
    await act(async () => {
      receipt = capturedHook!.restoreReadingRef(origin.ref, undefined, { refresh: true });
    });
    const settled = vi.fn();
    void receipt.then(settled);
    await act(async () => {
      for (let n = 0; n < 100; n++) flushAnimationFrames();
    });
    expect(settled).not.toHaveBeenCalled();
    await act(async () => {
      firstPage({ ok: true, json: async () => ({ messages: [makeMsg('middle', 5)], hasMore: true }) } as Response);
    });
    expect(secondPage).toBeTypeOf('function');
    await act(async () => {
      for (let n = 0; n < 100; n++) flushAnimationFrames();
    });
    expect(settled).not.toHaveBeenCalled();
    await act(async () => {
      secondPage({ ok: true, json: async () => ({ messages: [makeMsg('first', 1)], hasMore: false }) } as Response);
    });
    appendMessageBoundary(el, 'first', () => ({ top: 100 - top.get(), bottom: 500 - top.get() }));
    await act(async () => {
      for (let n = 0; n < 8; n++) flushAnimationFrames();
    });
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'settled', exact: true }));
    expect(apiFetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('before='))).toEqual([
      expect.stringContaining('10%3Alatest'),
      expect.stringContaining('5%3Amiddle'),
    ]);
    expect(top.get()).toBe(200);
  });

  it.each(['denied', 'no-progress'])('ends %s history paging without losing its reusable origin', async (failure) => {
    const threadId = `return-page-${failure}`;
    await openThread(threadId);
    act(() => {
      const gesture = beginGesture();
      gesture.scrollTo(200);
      gesture.end();
    });
    const origin = capturedHook!.captureReadingRef()!;
    const latest = [makeMsg('latest', 10)];
    saveChatScrollState(threadId, { top: 600, anchor: 'bottom' });
    act(() =>
      useChatStore.setState({
        messages: latest,
        hasMore: true,
        threadStates: { [threadId]: { ...makeThreadState(latest), hasMore: true } },
      }),
    );
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: latest, hasMore: true }),
    } as Response);
    apiFetchMock.mockResolvedValueOnce(
      failure === 'denied'
        ? ({ ok: false, status: 403 } as Response)
        : ({ ok: true, json: async () => ({ messages: latest, hasMore: true }) } as Response),
    );
    let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingRef']>;
    await act(async () => {
      receipt = capturedHook!.restoreReadingRef(origin.ref, undefined, { refresh: true });
    });
    expect(await receipt).toEqual({ status: 'unavailable' });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(readChatReadingRef(origin.ref)?.threadId).toBe(threadId);
  });

  it('reports an exact message only after the original navigation owner settles, and fences superseded intents', async () => {
    const { top, second } = await openThread('search-target-receipt');
    const first = capturedHook!.navigateToMessage('first');
    const superseding = capturedHook!.navigateToMessage('second');
    expect(await first).toEqual({ status: 'interrupted' });
    const reported = vi.fn();
    void superseding.then(reported);
    expect(reported).not.toHaveBeenCalled();
    second.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = () => top.set(500);
    await act(async () => {
      for (let n = 0; n < 8; n++) flushAnimationFrames();
      await superseding;
    });
    expect(await superseding).toMatchObject({
      status: 'settled',
      threadId: 'search-target-receipt',
      messageId: 'second',
      position: { anchor: 'offset', messageAnchor: { messageId: 'second' } },
    });
  });

  it('persists the final explicit target anchor even when smooth scrolling initially pauses', async () => {
    const { top, second } = await openThread('search-final-anchor');
    const target = second.querySelector<HTMLElement>('[data-message-id]')!;
    target.getBoundingClientRect = () => ({ height: 800 }) as DOMRect;
    target.scrollIntoView = vi.fn((options: ScrollIntoViewOptions) => {
      top.set(options.behavior === 'instant' ? 400 : 659);
    });
    const receipt = capturedHook!.navigateToMessage('second');
    await act(async () => {
      for (let n = 0; n < 8; n++) flushAnimationFrames();
      await receipt;
    });
    // The later real scroll event changes pixels but preserves the saved anchor.
    top.set(400);
    act(() => capturedHook!.handleScroll());
    expect(readChatScrollState('search-final-anchor')).toMatchObject({
      top: 400,
      messageAnchor: { messageId: 'second', viewportOffsetPx: 0 },
    });
    expect(await receipt).toMatchObject({ position: { top: 400, messageAnchor: { viewportOffsetPx: 0 } } });
  });

  it('withdraws an owned navigation before a stale frame can scroll while a newer source is being checked', async () => {
    const { top, second } = await openThread('source-check-cancellation');
    second.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = () => top.set(500);
    const controller = new AbortController();
    const receipt = capturedHook!.navigateToMessage('second', controller.signal);
    const obsolete = [...rafCallbacks.values()];
    const settled = vi.fn();
    void receipt.then(settled);
    await act(async () => {
      controller.abort();
      await Promise.resolve();
    });
    expect(settled).toHaveBeenCalledWith({ status: 'interrupted' });
    act(() => obsolete.forEach((frame) => frame(16)));
    expect(top.get()).toBe(600);
    expect(await capturedHook!.navigateToMessage('first', controller.signal)).toEqual({ status: 'interrupted' });
  });

  it('withdraws an owned return without deleting its reusable opaque origin', async () => {
    const { top } = await openThread('source-return-cancellation');
    const origin = capturedHook!.captureReadingRef()!;
    act(() => beginGesture().scrollTo(200));
    const controller = new AbortController();
    let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingRef']>;
    act(() => {
      receipt = capturedHook!.restoreReadingRef(origin.ref, controller.signal);
    });
    const settled = vi.fn();
    void receipt.then(settled);
    await act(async () => {
      controller.abort();
      await Promise.resolve();
    });
    expect(settled).toHaveBeenCalledWith({ status: 'interrupted' });
    act(() => {
      for (let n = 0; n < 8; n++) flushAnimationFrames();
    });
    expect(top.get()).toBe(200);
    expect(readChatScrollState('source-return-cancellation')?.top).toBe(200);
    expect(readChatReadingRef(origin.ref)?.threadId).toBe('source-return-cancellation');
  });

  it('refreshes canonical history before a search target can settle, instead of rendering an edited cached body', async () => {
    const { top, second } = await openThread('source-fresh-history');
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ ...makeMsg('second', 2), content: 'Edited canonical body' }], hasMore: false }),
    } as Response);
    second.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = () => top.set(500);
    let receipt!: Promise<import('../useChatHistory').ChatMessageNavigationReceipt>;
    await act(async () => {
      receipt = capturedHook!.navigateToMessage('second', undefined, { refresh: true });
      for (let n = 0; n < 10; n++) await Promise.resolve();
    });
    expect(apiFetchMock.mock.calls.some(([url]) => url.startsWith('/api/messages?'))).toBe(true);
    expect(
      useChatStore
        .getState()
        .getThreadState('source-fresh-history')
        .messages.find((msg) => msg.id === 'second')?.content,
    ).toBe('Edited canonical body');
    await act(async () => {
      for (let n = 0; n < 8; n++) flushAnimationFrames();
      await receipt;
    });
    expect(await receipt).toMatchObject({ status: 'settled', messageId: 'second' });
  });

  it('cannot navigate a cached target after the original history refresh is denied', async () => {
    const { top } = await openThread('source-denied-history');
    apiFetchMock.mockResolvedValue({ ok: false, status: 403 } as Response);
    let receipt!: Promise<import('../useChatHistory').ChatMessageNavigationReceipt>;
    await act(async () => {
      receipt = capturedHook!.navigateToMessage('second', undefined, { refresh: true });
    });
    const result = vi.fn();
    void receipt.then(result);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result).toHaveBeenCalledWith({ status: 'unavailable' });
    expect(top.get()).toBe(600);
  });

  it('retires an explicit restore receipt on new input, and rejects another thread snapshot', async () => {
    const { top } = await openThread('search-reading-generation');
    expect(capturedHook!.captureReadingPosition).toBeTypeOf('function');
    const snapshot = capturedHook!.captureReadingPosition()!;
    expect(await capturedHook!.restoreReadingPosition({ ...snapshot, threadId: 'other' })).toEqual({
      status: 'unavailable',
    });
    const foreign = captureChatReadingRef({ ...snapshot, threadId: 'other' })!;
    expect(await capturedHook!.restoreReadingRef(foreign.ref)).toEqual({ status: 'unavailable' });
    expect(capturedHook!.releaseReadingRef(foreign.ref)).toBe(false);
    expect(await capturedHook!.restoreReadingRef('missing')).toEqual({ status: 'unavailable' });
    const captured = capturedHook!.captureReadingRef()!;
    let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
    act(() => {
      receipt = capturedHook!.restoreReadingRef(captured.ref);
    });
    act(() => {
      beginGesture().scrollTo(200);
      flushAnimationFrames();
    });
    expect(await receipt).toEqual({ status: 'interrupted' });
    expect(top.get()).toBe(200);
  });

  it('loads an older exact target through the existing history cursor before reporting arrival', async () => {
    const threadId = 'search-older-target';
    const { el, top } = await openThread(threadId);
    const older = makeMsg('older', 0);
    apiFetchMock.mockImplementation(
      async (url) =>
        ({
          ok: true,
          json: async () =>
            String(url).includes('before=') ? { messages: [older], hasMore: false } : { messages: [], hasMore: false },
        }) as Response,
    );
    act(() => {
      const current = useChatStore.getState().getThreadState(threadId);
      useChatStore.setState({ hasMore: true, threadStates: { [threadId]: { ...current, hasMore: true } } });
    });
    const boundary = appendMessageBoundary(el, 'older', () => ({ top: 100 - top.get(), bottom: 500 - top.get() }));
    boundary.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = () => top.set(100);
    let receipt!: Promise<import('../useChatHistory').ChatMessageNavigationReceipt>;
    await act(async () => {
      receipt = capturedHook!.navigateToMessage(older.id);
      for (let n = 0; n < 5; n++) await Promise.resolve();
    });
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes('before=1%3Afirst'))).toBe(true);
    await act(async () => {
      for (let n = 0; n < 8; n++) flushAnimationFrames();
      await receipt;
    });
    expect(await receipt).toMatchObject({ status: 'settled', threadId, messageId: older.id });
    expect(top.get()).toBe(100);
  });

  it('keeps unavailable and interrupted target receipts distinct without accepting a mounted wrong surface', async () => {
    await openThread('search-missing-target');
    expect(await capturedHook!.navigateToMessage('not-in-history')).toEqual({ status: 'unavailable' });
    const pending = capturedHook!.navigateToMessage('first');
    act(() => beginGesture().scrollTo(300));
    expect(await pending).toEqual({ status: 'interrupted' });
    act(() => useChatStore.setState({ currentThreadId: 'somewhere-else' }));
    expect(await capturedHook!.navigateToMessage('first')).toEqual({ status: 'unavailable' });
  });

  it('restores the same canonical response id after streaming finalization', async () => {
    const threadId = 'search-return-finalized';
    const { el, top } = await openThread(threadId);
    const original = [
      { ...makeMsg('first', 1), extra: { stream: { turnInvocationId: 'origin-turn' } } },
      makeMsg('second', 2),
    ];
    act(() => useChatStore.setState({ messages: original, threadStates: { [threadId]: makeThreadState(original) } }));
    const gesture = beginGesture();
    act(() => {
      gesture.scrollTo(200);
      gesture.end();
    });
    const snapshot = capturedHook!.captureReadingPosition()!;
    expect(snapshot.position).toMatchObject({ messageAnchor: { messageId: 'first' } });
    const finalized = [{ ...original[0], isStreaming: false, content: 'finalized response' }, original[1]];
    act(() => useChatStore.setState({ messages: finalized, threadStates: { [threadId]: makeThreadState(finalized) } }));
    const boundary = el.querySelector<HTMLElement>('[data-message-viewport-id="first"]')!;
    expect(boundary.dataset.messageViewportId).toBe('first');
    expect(boundary.querySelector<HTMLElement>('[data-message-id="first"]')).not.toBeNull();
    act(() => beginGesture().scrollTo(500));
    let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
    act(() => {
      receipt = capturedHook!.restoreReadingPosition(snapshot);
    });
    await act(async () => {
      for (let n = 0; n < 100; n++) flushAnimationFrames();
      await receipt;
    });
    expect(await receipt).toMatchObject({ status: 'settled', exact: true });
    expect(top.get()).toBe(200);
    expect(readChatScrollState(threadId)).toMatchObject({
      messageAnchor: { messageId: 'first', viewportOffsetPx: -200 },
    });
  });

  it('captures bottom follow and restores it against the new document height', async () => {
    const { el, top } = await openThread('search-return-bottom');
    expect(capturedHook!.captureReadingPosition).toBeTypeOf('function');
    const snapshot = capturedHook!.captureReadingPosition()!;
    expect(snapshot.position.anchor).toBe('bottom');
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1500 });
    top.set(200);
    let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
    act(() => {
      receipt = capturedHook!.restoreReadingPosition(snapshot);
    });
    await act(async () => {
      for (let n = 0; n < 4; n++) flushAnimationFrames();
      await receipt;
    });
    expect(await receipt).toMatchObject({ status: 'settled', exact: true });
    expect(top.get()).toBe(900);
    expect(readChatScrollState('search-return-bottom')).toEqual({ anchor: 'bottom', top: 900 });
  });

  it('does not certify a legacy pixel fallback as the exact message reading place', async () => {
    const threadId = 'search-pixel-fallback';
    const { el } = await openThread(threadId);
    for (const boundary of el.querySelectorAll('[data-message-viewport-id]')) boundary.remove();
    let receipt!: Promise<import('../useChatHistory').ChatReadingRestoreReceipt>;
    act(() => {
      receipt = capturedHook!.restoreReadingPosition({ threadId, position: { top: 100, anchor: 'offset' } });
    });
    await act(async () => {
      for (let n = 0; n < 5; n++) flushAnimationFrames();
      await receipt;
    });
    expect(await receipt).toMatchObject({ status: 'settled', exact: false });
  });

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

  it('keeps the saved reading boundary when native content layout settles after the user scroll', async () => {
    const observers: Array<{ callback: ResizeObserverCallback; instance: ResizeObserver }> = [];
    const originalObserver = window.ResizeObserver;
    Object.assign(window, {
      ResizeObserver: class implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, instance: this });
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
    try {
      const { el, top } = await openThread('native-layout-reading');
      const boundary = el.querySelector<HTMLElement>('[data-message-viewport-id="first"]');
      if (!boundary) throw new Error('Missing original message boundary');
      let nativeLayoutShift = 0;
      boundary.getBoundingClientRect = () =>
        ({ top: 100 + nativeLayoutShift - top.get(), bottom: 500 + nativeLayoutShift - top.get() }) as DOMRect;
      act(() => {
        const gesture = beginGesture();
        gesture.scrollTo(200);
        gesture.end();
      });
      const saved = readChatScrollState('native-layout-reading');
      if (!saved || saved.anchor !== 'offset') throw new Error('Missing original reading intent');
      expect(saved.messageAnchor?.viewportOffsetPx).toBe(-200);
      nativeLayoutShift = 150;
      act(() => {
        for (const observer of observers) observer.callback([], observer.instance);
        flushAnimationFrames();
      });
      expect(boundary.getBoundingClientRect().top - el.getBoundingClientRect().top).toBe(-200);
      expect(readChatScrollState('native-layout-reading')).toMatchObject({
        anchor: 'offset',
        messageAnchor: saved.messageAnchor,
      });
    } finally {
      Object.assign(window, { ResizeObserver: originalObserver });
    }
  });

  it('captures the actual reading viewport before an explicit layout entry instead of reusing an older offset', async () => {
    const threadId = 'reading-before-layout-entry';
    const { el, top } = await openThread(threadId);
    act(() => {
      const gesture = beginGesture();
      gesture.scrollTo(200);
      gesture.end();
    });
    const boundary = el.querySelector<HTMLElement>('[data-message-viewport-id="first"]');
    if (!boundary) throw new Error('Missing original message boundary');
    boundary.getBoundingClientRect = () => ({ top: 250 - top.get(), bottom: 650 - top.get() }) as DOMRect;
    act(() => {
      window.dispatchEvent(new CustomEvent(CHAT_LAYOUT_CHANGED_EVENT, { detail: { captureCurrentReading: true } }));
    });
    expect(readChatScrollState(threadId)).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'first', viewportOffsetPx: -50 },
    });
    act(() => flushAnimationFrames());
    expect(top.get()).toBe(200);
  });

  it('recovers the physical widget input point when its queued notification arrives after an old restore RAF', async () => {
    const threadId = 'widget-input-delayed-delivery';
    const { el, top } = await openThread(threadId);
    defineMutableNumberProp(el, 'scrollHeight', 6000);
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      await act(async () => useChatStore.getState().setThreadLoadingHistory(threadId, true));
      let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
      act(() => {
        receipt = capturedHook!.restoreReadingPosition({ threadId, position: { top: 1630, anchor: 'offset' } });
      });
      top.set(2866); // Native iframe actionability scroll, at physical input.
      now = 110;
      const queuedNotification = new CustomEvent(CHAT_LAYOUT_CHANGED_EVENT, {
        detail: { captureCurrentReading: true, inputOccurredAt: performance.timeOrigin + now },
      });
      now = 120;
      act(() => flushAnimationFrames());
      expect(top.get()).toBe(1630); // Run the actual old owner write before IPC delivery.
      now = 130;
      await act(async () => window.dispatchEvent(queuedNotification));
      expect(top.get()).toBe(2866);
      expect(readChatScrollState(threadId)?.top).toBe(2866);
      expect(await receipt).toEqual({ status: 'interrupted' });
      act(() => flushAnimationFrames());
      expect(top.get()).toBe(2866);
    } finally {
      clock.mockRestore();
    }
  });

  async function mountReceiptWidget(el: HTMLElement) {
    el.dataset.chatContainer = '';
    const widgetContainer = document.createElement('div');
    el.appendChild(widgetContainer);
    const widgetRoot = createRoot(widgetContainer);
    const block = {
      id: 'receipt-widget',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<details><summary>More</summary>Body</details>',
    };
    await act(async () => widgetRoot.render(React.createElement(HtmlWidgetBlock, { block })));
    const iframe = widgetContainer.querySelector('iframe');
    const widget = widgetContainer.querySelector<HTMLElement>('[data-html-widget]');
    if (!iframe?.contentWindow || !widget) throw new Error('Missing real widget bridge');
    const source = iframe.contentWindow;
    const post = vi.spyOn(source, 'postMessage');
    const requests = () =>
      post.mock.calls
        .map(([data]) => data as Record<string, unknown>)
        .filter((data) => data.type === 'cat-cafe:html-widget-input-fence-request');
    const acknowledge = (
      request: Record<string, unknown>,
      overrides: Record<string, unknown> = {},
      origin = 'null',
      eventSource = source,
    ) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: eventSource,
          origin,
          data: { ...request, type: 'cat-cafe:html-widget-input-fence-ack', ...overrides },
        }),
      );
    return {
      widget,
      source,
      requests,
      acknowledge,
      replace: async () =>
        act(async () =>
          widgetRoot.render(React.createElement(HtmlWidgetBlock, { block: { ...block, html: '<p>Replacement</p>' } })),
        ),
      dispose: () => {
        post.mockRestore();
        act(() => widgetRoot.unmount());
        widgetContainer.remove();
      },
    };
  }

  it.each([
    'pending-input',
    'ack-input-epoch',
  ])('interrupts an authoritative message-anchored receipt with delayed %s', async (delivery) => {
    const threadId = 'widget-input-loaded-receipt';
    const { el, top } = await openThread(threadId);
    defineMutableNumberProp(el, 'scrollHeight', 6000);
    const fixture = await mountReceiptWidget(el);
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const { widget, source } = fixture;
      let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
      const completed = vi.fn();
      act(() => {
        receipt = capturedHook!.restoreReadingPosition({
          threadId,
          position: {
            top: 1630,
            anchor: 'offset',
            messageAnchor: { messageId: 'first', viewportOffsetPx: -1630, timelineOrderAt: 1 },
          },
        });
        void receipt.then(completed);
      });
      expect(useChatStore.getState().getThreadState(threadId).isLoadingHistory).toBe(false);
      top.set(2866);
      now = 110;
      const queuedInput = new MessageEvent('message', {
        source,
        origin: 'null',
        data: {
          type: 'cat-cafe:html-widget-size',
          v: 6,
          blockId: 'receipt-widget',
          instanceId: widget.dataset.htmlWidgetInstanceId,
          phase: 'pending',
          cause: 'content',
          preserveViewport: true,
          inputOccurredAt: performance.timeOrigin + now,
        },
      });
      now = 120;
      await act(async () => flushAnimationFrames());
      expect(top.get()).toBe(1630);
      expect(completed).not.toHaveBeenCalled(); // Pixel settlement cannot yet certify the return.
      now = 130;
      await act(async () => {
        if (delivery === 'pending-input') window.dispatchEvent(queuedInput);
        else fixture.acknowledge(fixture.requests()[0]!, { inputOccurredAt: performance.timeOrigin + 110 });
      });
      expect(top.get()).toBe(2866);
      expect(await receipt).toEqual({ status: 'interrupted' });
      act(() => flushAnimationFrames());
      expect(top.get()).toBe(2866);
    } finally {
      clock.mockRestore();
      fixture.dispose();
    }
  });

  it('settles exact only after the current child acknowledges, rejecting foreign or malformed acknowledgements', async () => {
    const threadId = 'widget-receipt-confirmation';
    const { el, top } = await openThread(threadId);
    const fixture = await mountReceiptWidget(el);
    try {
      let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
      const completed = vi.fn();
      act(() => {
        receipt = capturedHook!.restoreReadingPosition({
          threadId,
          position: { top: 200, anchor: 'offset', messageAnchor: { messageId: 'first', viewportOffsetPx: -200 } },
        });
        void receipt.then(completed);
      });
      await act(async () => flushAnimationFrames());
      expect(top.get()).toBe(200);
      const request = fixture.requests()[0]!;
      expect(request).toBeDefined();
      for (const invalid of [
        { blockId: 'foreign' },
        { instanceId: 'stale' },
        { requestId: 'stale' },
        { v: 7 },
        { inputOccurredAt: NaN },
        { inputOccurredAt: -1 },
      ]) {
        await act(async () => fixture.acknowledge(request, invalid));
        expect(completed).not.toHaveBeenCalled();
      }
      await act(async () => {
        fixture.acknowledge(request, {}, 'https://foreign.test');
        fixture.acknowledge(request, {}, 'null', window);
      });
      expect(completed).not.toHaveBeenCalled();
      await act(async () => fixture.acknowledge(request));
      expect(await receipt).toMatchObject({ status: 'settled', exact: true });
      expect(top.get()).toBe(200);
    } finally {
      fixture.dispose();
    }
  });

  it.each([0.5, -0.5])('keeps the original anchor contract after browser scroll quantization (%spx)', async (shift) => {
    const threadId = `widget-receipt-quantized-${shift}`;
    const { el, top } = await openThread(threadId);
    const boundary = el.querySelector<HTMLElement>('[data-message-viewport-id="first"]')!;
    boundary.getBoundingClientRect = () =>
      ({ top: 100 + shift - top.get(), bottom: 500 + shift - top.get() }) as DOMRect;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top.get(),
      set: (value: number) => top.set(Math.round(value)),
    });
    const fixture = await mountReceiptWidget(el);
    try {
      let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
      const completed = vi.fn();
      act(() => {
        receipt = capturedHook!.restoreReadingPosition({
          threadId,
          position: { top: 200, anchor: 'offset', messageAnchor: { messageId: 'first', viewportOffsetPx: -200 } },
        });
        void receipt.then(completed);
      });
      await act(async () => flushAnimationFrames());
      expect(top.get()).toBe(Math.round(200 + shift));
      expect(completed).not.toHaveBeenCalled();
      expect(fixture.requests()[0]).toBeDefined();
      await act(async () => fixture.acknowledge(fixture.requests()[0]!));
      expect(await receipt).toMatchObject({
        status: 'settled',
        exact: true,
        position: { messageAnchor: { messageId: 'first', viewportOffsetPx: -200 } },
      });
    } finally {
      fixture.dispose();
    }
  });

  it.each([2, -2])('rejects a real anchor displacement while its acknowledgement is pending (%spx)', async (reflow) => {
    const threadId = `widget-receipt-displaced-${reflow}`;
    const { el, top } = await openThread(threadId);
    let shift = 0;
    const boundary = el.querySelector<HTMLElement>('[data-message-viewport-id="first"]')!;
    boundary.getBoundingClientRect = () =>
      ({ top: 100 + shift - top.get(), bottom: 500 + shift - top.get() }) as DOMRect;
    const fixture = await mountReceiptWidget(el);
    try {
      let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
      act(() => {
        receipt = capturedHook!.restoreReadingPosition({
          threadId,
          position: { top: 200, anchor: 'offset', messageAnchor: { messageId: 'first', viewportOffsetPx: -200 } },
        });
      });
      await act(async () => flushAnimationFrames());
      shift = reflow;
      await act(async () => fixture.acknowledge(fixture.requests()[0]!));
      expect(await receipt).toEqual({ status: 'unavailable' });
    } finally {
      fixture.dispose();
    }
  });

  it('preserves interruption even when the acknowledged input leaves the quantized position unchanged', async () => {
    const threadId = 'widget-receipt-quantized-input';
    const { el, top } = await openThread(threadId);
    const boundary = el.querySelector<HTMLElement>('[data-message-viewport-id="first"]')!;
    boundary.getBoundingClientRect = () => ({ top: 100.5 - top.get(), bottom: 500.5 - top.get() }) as DOMRect;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top.get(),
      set: (value: number) => top.set(Math.round(value)),
    });
    const fixture = await mountReceiptWidget(el);
    try {
      let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
      act(() => {
        receipt = capturedHook!.restoreReadingPosition({
          threadId,
          position: { top: 200, anchor: 'offset', messageAnchor: { messageId: 'first', viewportOffsetPx: -200 } },
        });
      });
      await act(async () => flushAnimationFrames());
      await act(async () =>
        fixture.acknowledge(fixture.requests()[0]!, { inputOccurredAt: performance.timeOrigin + performance.now() }),
      );
      expect(top.get()).toBe(201);
      expect(await receipt).toEqual({ status: 'interrupted' });
    } finally {
      fixture.dispose();
    }
  });

  it('cannot let a stale child acknowledgement settle or interrupt a newer restore receipt', async () => {
    const threadId = 'widget-receipt-new-generation';
    const { el, top } = await openThread(threadId);
    const fixture = await mountReceiptWidget(el);
    try {
      const restore = (position: number) =>
        capturedHook!.restoreReadingPosition({
          threadId,
          position: {
            top: position,
            anchor: 'offset',
            messageAnchor: { messageId: 'first', viewportOffsetPx: -position },
          },
        });
      let first!: ReturnType<typeof restore>;
      act(() => {
        first = restore(200);
      });
      await act(async () => flushAnimationFrames());
      const oldRequest = fixture.requests()[0]!;
      let second!: ReturnType<typeof restore>;
      const completed = vi.fn();
      act(() => {
        second = restore(300);
        void second.then(completed);
      });
      expect(await first).toEqual({ status: 'interrupted' });
      await act(async () => flushAnimationFrames());
      expect(top.get()).toBe(300);
      await act(async () =>
        fixture.acknowledge(oldRequest, { inputOccurredAt: performance.timeOrigin + performance.now() }),
      );
      expect(completed).not.toHaveBeenCalled();
      expect(top.get()).toBe(300);
      await act(async () => fixture.acknowledge(fixture.requests()[1]!));
      expect(await second).toMatchObject({ status: 'settled', exact: true });
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    'unresponsive-child',
    'replaced-document',
  ])('does not certify exact when the input fence is %s', async (failure) => {
    const threadId = `widget-receipt-${failure}`;
    const { el } = await openThread(threadId);
    const fixture = await mountReceiptWidget(el);
    try {
      let receipt!: ReturnType<ReturnType<typeof useChatHistory>['restoreReadingPosition']>;
      act(() => {
        receipt = capturedHook!.restoreReadingPosition({
          threadId,
          position: { top: 200, anchor: 'offset', messageAnchor: { messageId: 'first', viewportOffsetPx: -200 } },
        });
      });
      await act(async () => flushAnimationFrames());
      if (failure === 'replaced-document') await fixture.replace();
      else
        await act(async () => {
          for (let frame = 0; frame < 90; frame++) flushAnimationFrames();
        });
      expect(await receipt).toEqual({ status: 'unavailable' });
      await act(async () => fixture.acknowledge(fixture.requests()[0]!));
      expect(await receipt).toEqual({ status: 'unavailable' });
    } finally {
      fixture.dispose();
    }
  });

  it('does not let a delayed widget notification or measurement undo newer real reading input', async () => {
    const threadId = 'widget-input-newer-gesture';
    const { el, top } = await openThread(threadId);
    defineMutableNumberProp(el, 'scrollHeight', 6000);
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      await act(async () => useChatStore.getState().setThreadLoadingHistory(threadId, true));
      act(() => {
        void capturedHook!.restoreReadingPosition({ threadId, position: { top: 1630, anchor: 'offset' } });
      });
      top.set(2866);
      const inputAt = performance.timeOrigin + 110;
      now = 120;
      act(() => flushAnimationFrames());
      expect(top.get()).toBe(1630);
      now = 125;
      act(() => {
        const gesture = beginGesture();
        gesture.scrollTo(900);
        gesture.end();
      });
      now = 130;
      act(() => {
        window.dispatchEvent(
          new CustomEvent(CHAT_LAYOUT_CHANGED_EVENT, {
            detail: { captureCurrentReading: true, inputOccurredAt: inputAt },
          }),
        );
        window.dispatchEvent(
          new CustomEvent(CHAT_LAYOUT_CHANGED_EVENT, {
            detail: {
              viewportAnchor: {
                element: el.firstElementChild,
                viewportTop: 10,
                fallbackScrollTop: 2866,
                inputOccurredAt: inputAt,
              },
            },
          }),
        );
        flushAnimationFrames();
      });
      expect(top.get()).toBe(900);
      expect(readChatScrollState(threadId)?.top).toBe(900);
    } finally {
      clock.mockRestore();
    }
  });

  it('recovers delayed input after an old passive anchor correction using the same owner checkpoint', async () => {
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const threadId = 'widget-input-passive-correction';
      const { el, top } = await openThread(threadId);
      defineMutableNumberProp(el, 'scrollHeight', 6000);
      act(() => {
        flushAnimationFrames();
        const gesture = beginGesture();
        gesture.scrollTo(600);
        gesture.end();
      });
      saveChatScrollState(threadId, {
        top: 1630,
        anchor: 'offset',
        messageAnchor: { messageId: 'first', viewportOffsetPx: -1630 },
      });
      act(() => window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT)));
      top.set(2866);
      now = 120;
      act(() => flushAnimationFrames());
      expect(top.get()).toBe(1630);
      now = 130;
      act(() =>
        window.dispatchEvent(
          new CustomEvent(CHAT_LAYOUT_CHANGED_EVENT, {
            detail: { captureCurrentReading: true, inputOccurredAt: performance.timeOrigin + 110 },
          }),
        ),
      );
      expect(top.get()).toBe(2866);
      expect(readChatScrollState(threadId)?.top).toBe(2866);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps a newer restore generation and its receipt when an older widget input arrives late', async () => {
    const threadId = 'widget-input-newer-restore';
    const { el, top } = await openThread(threadId);
    defineMutableNumberProp(el, 'scrollHeight', 6000);
    let now = 100;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      await act(async () => useChatStore.getState().setThreadLoadingHistory(threadId, true));
      act(() => {
        void capturedHook!.restoreReadingPosition({ threadId, position: { top: 1630, anchor: 'offset' } });
      });
      top.set(2866);
      now = 120;
      act(() => flushAnimationFrames());
      now = 125;
      const finished = vi.fn();
      act(() => {
        void capturedHook!
          .restoreReadingPosition({ threadId, position: { top: 250, anchor: 'offset' } })
          .then(finished);
      });
      now = 130;
      await act(async () =>
        window.dispatchEvent(
          new CustomEvent(CHAT_LAYOUT_CHANGED_EVENT, {
            detail: { captureCurrentReading: true, inputOccurredAt: performance.timeOrigin + 110 },
          }),
        ),
      );
      expect(finished).not.toHaveBeenCalled();
      act(() => flushAnimationFrames());
      expect(top.get()).toBe(250);
    } finally {
      clock.mockRestore();
    }
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

  it.each([
    'classic',
    'v2',
  ] as const)('uses the %s owner jump without animating v2 across unmounted history', async (shell) => {
    writeShellPresentation(shell);
    try {
      const { top, second } = await openThread(`piano-owner-jump-${shell}`);
      const target = second.querySelector<HTMLElement>('[data-message-id]')!;
      target.scrollIntoView = vi.fn((options: ScrollIntoViewOptions) => {
        top.set(options.behavior === 'instant' ? 350 : 600);
      });
      act(() => {
        jump('second');
        for (let frame = 0; frame < 5; frame++) flushAnimationFrames();
      });
      expect(target.scrollIntoView).toHaveBeenCalledWith({
        behavior: shell === 'v2' ? 'instant' : 'smooth',
        block: 'center',
      });
      if (shell === 'v2') expect(readChatScrollState(`piano-owner-jump-${shell}`)?.top).toBe(350);
    } finally {
      writeShellPresentation('classic');
    }
  });

  it('keeps native End input through its last scroll event before returning to passive observation', async () => {
    const threadId = 'piano-native-end-lifetime';
    const { el, top } = await openThread(threadId);
    saveChatScrollState(threadId, {
      top: 200,
      anchor: 'offset',
      messageAnchor: { messageId: 'first', viewportOffsetPx: -200 },
    });
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      top.set(400);
      capturedHook!.handleScroll();
      top.set(600);
      capturedHook!.handleScroll();
    });
    expect(readChatScrollState(threadId)).toEqual({ top: 600, anchor: 'bottom' });
    act(() => {
      el.dispatchEvent(new Event('scrollend'));
      jump('first');
    });
    const first = el.querySelector<HTMLElement>('[data-message-id="first"]')!;
    first.scrollIntoView = () => top.set(0);
    act(() => {
      for (let frame = 0; frame < 5; frame++) flushAnimationFrames();
    });
    act(() => capturedHook!.handleScroll());
    expect(readChatScrollState(threadId)).toMatchObject({ anchor: 'offset', messageAnchor: { messageId: 'first' } });
  });

  it('finishes native End at the new bottom when deferred rows grow beyond its original destination', async () => {
    const threadId = 'native-end-growing-bottom';
    const { el, top } = await openThread(threadId);
    top.set(200);
    saveChatScrollState(threadId, { top: 200, anchor: 'offset' });
    const end = capturedHook!.messagesEndRef.current!;
    end.scrollIntoView = vi.fn(() => top.set(el.scrollHeight - el.clientHeight));
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      top.set(400);
      capturedHook!.handleScroll();
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1600 });
      window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT));
      flushAnimationFrames();
    });
    expect(end.scrollIntoView).not.toHaveBeenCalled();
    act(() => {
      top.set(600); // The browser reaches the bottom measured at keydown.
      capturedHook!.handleScroll();
      el.dispatchEvent(new Event('scrollend'));
    });
    expect(top.get()).toBe(1000);
    expect(readChatScrollState(threadId)).toEqual({ top: 1000, anchor: 'bottom' });
    act(() => {
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1800 });
      window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT));
      flushAnimationFrames();
    });
    expect(top.get()).toBe(1200);
    expect(readChatScrollState(threadId)).toEqual({ top: 1200, anchor: 'bottom' });
  });

  it.each([
    'upward-wheel',
    'message-navigation',
    'thread-switch',
  ] as const)('cancels an unfinished End destination on %s', async (interrupt) => {
    const threadId = `native-end-cancel-${interrupt}`;
    const { el, top } = await openThread(threadId);
    top.set(200);
    saveChatScrollState(threadId, { top: 200, anchor: 'offset' });
    const end = capturedHook!.messagesEndRef.current!;
    end.scrollIntoView = vi.fn(() => top.set(el.scrollHeight - el.clientHeight));
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      top.set(400);
      capturedHook!.handleScroll();
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1600 });
      if (interrupt === 'upward-wheel') {
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
        top.set(300);
        capturedHook!.handleScroll();
      } else if (interrupt === 'message-navigation') {
        const first = el.querySelector<HTMLElement>('[data-message-id="first"]')!;
        first.scrollIntoView = vi.fn(() => top.set(0));
        jump('first');
      } else {
        useChatStore.setState({ currentThreadId: 'other-thread' });
      }
      el.dispatchEvent(new Event('scrollend'));
      window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT));
      flushAnimationFrames();
    });
    expect(end.scrollIntoView).not.toHaveBeenCalled();
    expect(readChatScrollState(threadId)?.anchor).toBe('offset');
  });

  it.each([
    'PageDown',
    'wheel',
    'click',
    'outside-End',
  ] as const)('keeps offset reading after %s when geometry grows', async (input) => {
    const threadId = `native-offset-growth-${input}`;
    const { el, top } = await openThread(threadId);
    top.set(200);
    saveChatScrollState(threadId, { top: 200, anchor: 'offset' });
    const end = capturedHook!.messagesEndRef.current!;
    act(() => {
      if (input === 'wheel') el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
      else if (input === 'click') el.dispatchEvent(new Event('pointerdown'));
      else if (input === 'outside-End') {
        const control = document.createElement('button');
        container.appendChild(control);
        control.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      } else el.dispatchEvent(new KeyboardEvent('keydown', { key: input, bubbles: true }));
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1600 });
      if (input !== 'click') top.set(600);
      capturedHook!.handleScroll();
      el.dispatchEvent(new Event('scrollend'));
      window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT));
      flushAnimationFrames();
    });
    expect(end.scrollIntoView).not.toHaveBeenCalled();
    expect(readChatScrollState(threadId)?.anchor).toBe('offset');
  });

  it('keeps an explicit last-message anchor through passive bottom observations and late layout', async () => {
    const threadId = 'piano-last-source-late-layout';
    const { el, top, second } = await openThread(threadId);
    let shift = 0;
    second.getBoundingClientRect = () =>
      ({ top: 500 + shift - top.get(), bottom: 1300 + shift - top.get() }) as DOMRect;
    const target = second.querySelector<HTMLElement>('[data-message-id]')!;
    target.scrollIntoView = () => top.set(600);
    act(() => {
      jump('second');
      for (let frame = 0; frame < 5; frame++) flushAnimationFrames();
      capturedHook!.handleScroll();
    });
    expect(readChatScrollState(threadId)).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'second', viewportOffsetPx: -200 },
    });
    shift = 400;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1600 });
    act(() => {
      window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT));
      flushAnimationFrames();
      capturedHook!.handleScroll();
    });
    expect(top.get()).toBe(1000);
    expect(readChatScrollState(threadId)).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'second', viewportOffsetPx: -200 },
    });
    act(() => {
      const gesture = beginGesture();
      gesture.scrollTo(1000);
      gesture.end();
    });
    expect(readChatScrollState(threadId)).toEqual({ top: 1000, anchor: 'bottom' });
  });

  it.each([
    300, 600, 800,
  ])('settles at a %ipx reply header when earlier rows shrink after native arrival', async (height) => {
    const threadId = `reply-header-after-earlier-reflow-${height}`;
    const { top, second } = await openThread(threadId);
    let shift = 0;
    const rect = () => ({ top: 500 + shift - top.get(), bottom: 500 + height + shift - top.get(), height }) as DOMRect;
    second.getBoundingClientRect = rect;
    const target = second.querySelector<HTMLElement>('[data-message-id]')!;
    target.getBoundingClientRect = rect;
    target.scrollIntoView = vi.fn(() => top.set(400 - Math.max(0, (600 - height) / 2)));

    act(() => {
      jump('second');
      flushAnimationFrames();
    });
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: height > 600 ? 'start' : 'center',
    });
    // The browser reached the reply; a preceding content-visibility row then
    // shrinks. A partly visible short or equal-height reply also loses its header.
    shift = -200;
    act(() => {
      for (let frame = 0; frame < 8; frame++) flushAnimationFrames();
    });
    expect(top.get()).toBe(200);
    expect(readChatScrollState(threadId)).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'second', viewportOffsetPx: 0 },
    });
  });

  it.each([
    117.5, 289.859375, 625,
  ])('settles a fitting %ipx reply completely inside the history viewport after native arrival reflows', async (height) => {
    const threadId = `short-reply-clipped-tail-${height}`;
    const { el, top, second } = await openThread(threadId);
    let shift = 0;
    let renderedHeight = 93.5;
    const viewport = { top: 129, bottom: 754, height: 625 };
    el.getBoundingClientRect = () => viewport as DOMRect;
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: viewport.height });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 5000 });
    const rect = () =>
      ({
        top: 1500 + shift - top.get(),
        bottom: 1500 + renderedHeight + shift - top.get(),
        height: renderedHeight,
      }) as DOMRect;
    second.getBoundingClientRect = rect;
    const target = second.querySelector<HTMLElement>('[data-message-id]')!;
    target.getBoundingClientRect = rect;
    target.scrollIntoView = vi.fn(() => top.set(1500 - viewport.top - (viewport.height - renderedHeight) / 2));

    const receipt = capturedHook!.navigateToMessage('second');
    act(() => flushAnimationFrames());
    // A first native center alignment can be invalidated by deferred row
    // layout. These are the two observed short heights and the exact-fit edge;
    // the captured first-next target begins at 719.5 in a 129..754 viewport.
    shift = 719.5 - (viewport.top + (viewport.height - renderedHeight) / 2);
    renderedHeight = height;
    await act(async () => {
      for (let frame = 0; frame < 8; frame++) flushAnimationFrames();
      await receipt;
    });
    expect(await receipt).toMatchObject({ status: 'settled', threadId, messageId: 'second' });
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(viewport.top - 1);
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(viewport.bottom + 1);
    expect(readChatScrollState(threadId)).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'second', viewportOffsetPx: 0 },
    });
  });

  it('keeps a short reply centered when its full content remains visible', async () => {
    const { top, second } = await openThread('short-reply-centered');
    const rect = () => ({ top: 500 - top.get(), bottom: 800 - top.get(), height: 300 }) as DOMRect;
    second.getBoundingClientRect = rect;
    const target = second.querySelector<HTMLElement>('[data-message-id]')!;
    target.getBoundingClientRect = rect;
    target.scrollIntoView = vi.fn(() => top.set(250));
    act(() => {
      jump('second');
      for (let frame = 0; frame < 8; frame++) flushAnimationFrames();
    });
    expect(top.get()).toBe(250);
    expect(readChatScrollState('short-reply-centered')).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'second', viewportOffsetPx: 150 },
    });
  });

  it('keeps the v2 source highlighted for a full interval after a late visible arrival', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    writeShellPresentation('v2');
    try {
      const { el, top, second } = await openThread('v2-late-source-highlight');
      top.set(0);
      second.getBoundingClientRect = () => ({ top: 5100 - top.get(), bottom: 5300 - top.get() }) as DOMRect;
      const target = second.querySelector<HTMLElement>('[data-message-id]')!;
      target.scrollIntoView = vi.fn();
      act(() => {
        jump('second');
        flushAnimationFrames();
        for (let frame = 1; frame <= 12; frame++) {
          vi.advanceTimersByTime(150);
          top.set(frame * 300);
          flushAnimationFrames();
        }
        top.set(5000);
        for (let frame = 0; frame < 4; frame++) flushAnimationFrames();
      });
      expect(second.getBoundingClientRect().top).toBe(el.getBoundingClientRect().top);
      expect(readChatScrollState('v2-late-source-highlight')).toMatchObject({
        anchor: 'offset',
        messageAnchor: { messageId: 'second' },
      });
      expect(target.dataset.messageJumpFocus === 'true').toBe(true);
      act(() => vi.advanceTimersByTime(3199));
      expect(target.dataset.messageJumpFocus === 'true').toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(target.dataset.messageJumpFocus === 'true').toBe(false);
    } finally {
      vi.useRealTimers();
      writeShellPresentation('classic');
    }
  });

  it.each([
    'layout',
    'mount',
    'resize',
  ] as const)('keeps the v2 arrival interval through passive %s correction without restarting it', async (signal) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    writeShellPresentation('v2');
    const originalObserver = window.ResizeObserver;
    let deliverResize = () => {};
    Object.assign(window, {
      ResizeObserver: class implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          deliverResize = () => callback([], this);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
    try {
      const threadId = `v2-passive-${signal}-highlight`;
      const { el, top, second } = await openThread(threadId);
      let shift = 0;
      second.getBoundingClientRect = () =>
        ({ top: 500 + shift - top.get(), bottom: 1300 + shift - top.get() }) as DOMRect;
      const target = second.querySelector<HTMLElement>('[data-message-id]')!;
      target.scrollIntoView = vi.fn(() => top.set(350));
      act(() => {
        jump('second');
        for (let frame = 0; frame < 5; frame++) flushAnimationFrames();
      });
      expect(target.dataset.messageJumpFocus === 'true').toBe(true);
      const saved = readChatScrollState(threadId);
      if (!saved || saved.anchor !== 'offset') throw new Error('Missing settled source reading state');
      shift = 150;
      act(() => {
        vi.advanceTimersByTime(250);
        if (signal === 'resize') deliverResize();
        else
          window.dispatchEvent(
            new Event(signal === 'mount' ? MESSAGE_VIEWPORT_MOUNTED_EVENT : CHAT_LAYOUT_CHANGED_EVENT),
          );
        flushAnimationFrames();
      });
      expect(top.get()).toBe(500);
      expect(second.getBoundingClientRect().top - el.getBoundingClientRect().top).toBe(50);
      expect(readChatScrollState(threadId)).toEqual({ ...saved, top: 500 });
      expect(target.dataset.messageJumpFocus === 'true').toBe(true);
      act(() => vi.advanceTimersByTime(2949));
      expect(target.dataset.messageJumpFocus === 'true').toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(target.dataset.messageJumpFocus === 'true').toBe(false);
    } finally {
      Object.assign(window, { ResizeObserver: originalObserver });
      vi.useRealTimers();
      writeShellPresentation('classic');
    }
  });

  it.each([
    'user',
    'replacement',
    'thread',
  ] as const)('still clears the v2 hint on %s cancellation after passive correction', async (reason) => {
    writeShellPresentation('v2');
    try {
      const { el, top, second } = await openThread(`v2-passive-then-${reason}`);
      const target = second.querySelector<HTMLElement>('[data-message-id]')!;
      target.scrollIntoView = vi.fn(() => top.set(350));
      act(() => {
        jump('second');
        for (let frame = 0; frame < 5; frame++) flushAnimationFrames();
        window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT));
        flushAnimationFrames();
      });
      expect(target.dataset.messageJumpFocus === 'true').toBe(true);
      if (reason === 'thread') {
        await act(async () => root.render(React.createElement(HookHost, { threadId: 'next-thread' })));
      } else {
        act(() => {
          if (reason === 'replacement') {
            el.querySelector<HTMLElement>('[data-message-id="first"]')!.scrollIntoView = vi.fn();
            jump('first');
          } else {
            const gesture = beginGesture();
            gesture.scrollTo(200);
            gesture.end();
          }
        });
      }
      expect(target.dataset.messageJumpFocus === 'true').toBe(false);
    } finally {
      writeShellPresentation('classic');
    }
  });

  it('does not settle an offscreen reply after deferred content changes the layout', async () => {
    const threadId = 'f321-layout-shift-navigation';
    const { el, top, second } = await openThread(threadId);
    let layoutShift = 0;
    second.getBoundingClientRect = () =>
      ({ top: 500 + layoutShift - top.get(), bottom: 1300 + layoutShift - top.get() }) as DOMRect;
    second.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = vi.fn(() => top.set(350));
    act(() => {
      jump('second');
      flushAnimationFrames();
    });
    layoutShift = 1500;
    act(() => {
      for (let frame = 0; frame < 6; frame++) flushAnimationFrames();
    });
    expect(top.get()).toBe(1900);
    expect(readChatScrollState(threadId)).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'second', viewportOffsetPx: 0 },
    });
    expect(second.getBoundingClientRect().top).toBe(el.getBoundingClientRect().top);
  });

  it('cancels the v2 arrival highlight with the original user-input owner', async () => {
    writeShellPresentation('v2');
    try {
      const { top, second } = await openThread('v2-highlight-user-interruption');
      const target = second.querySelector<HTMLElement>('[data-message-id]')!;
      target.scrollIntoView = vi.fn(() => top.set(350));
      act(() => {
        jump('second');
        for (let frame = 0; frame < 5; frame++) flushAnimationFrames();
      });
      expect(target.dataset.messageJumpFocus === 'true').toBe(true);
      act(() => {
        const gesture = beginGesture();
        gesture.scrollTo(200);
        gesture.end();
      });
      expect(target.dataset.messageJumpFocus === 'true').toBe(false);
      expect(top.get()).toBe(200);
    } finally {
      writeShellPresentation('classic');
    }
  });

  it('does not highlight an interrupted v2 navigation when its old target becomes visible later', async () => {
    writeShellPresentation('v2');
    try {
      const { top, second } = await openThread('v2-highlight-cancel-before-arrival');
      top.set(0);
      second.getBoundingClientRect = () => ({ top: 5000 - top.get(), bottom: 5200 - top.get() }) as DOMRect;
      const target = second.querySelector<HTMLElement>('[data-message-id]')!;
      target.scrollIntoView = vi.fn();
      act(() => {
        jump('second');
        flushAnimationFrames();
        const gesture = beginGesture();
        gesture.scrollTo(5000);
        gesture.end();
        for (let frame = 0; frame < 5; frame++) flushAnimationFrames();
      });
      expect(target.dataset.messageJumpFocus === 'true').toBe(false);
    } finally {
      writeShellPresentation('classic');
    }
  });

  it('does not snap an offscreen target while smooth navigation is beginning or moving', async () => {
    const { top, second } = await openThread('navigation-in-flight');
    top.set(0);
    second.getBoundingClientRect = () => ({ top: 5000 - top.get(), bottom: 5800 - top.get() }) as DOMRect;
    second.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = vi.fn();
    act(() => {
      jump('second');
      for (let frame = 0; frame < 2; frame++) flushAnimationFrames();
    });
    expect(top.get()).toBe(0);
    act(() => {
      for (const frameTop of [10, 50, 100, 200]) {
        top.set(frameTop);
        flushAnimationFrames();
        expect(top.get()).toBe(frameTop);
      }
    });
  });

  it('preserves centering of a tall reply that overlaps the entire viewport', async () => {
    const threadId = 'navigation-tall-reply';
    const { top, second } = await openThread(threadId);
    second.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = vi.fn(() => top.set(500));
    act(() => {
      jump('second');
      for (let frame = 0; frame < 6; frame++) flushAnimationFrames();
    });
    expect(top.get()).toBe(500);
    expect(readChatScrollState(threadId)).toMatchObject({
      top: 500,
      messageAnchor: { messageId: 'second', viewportOffsetPx: -100 },
    });
  });
  it('waits through a smooth scroll longer than 90 frames before recording its final position', async () => {
    const threadId = 'navigation-high-refresh';
    const { top, second } = await openThread(threadId);
    top.set(0);
    second.getBoundingClientRect = () => ({ top: 5000 - top.get(), bottom: 5800 - top.get() }) as DOMRect;
    second.querySelector<HTMLElement>('[data-message-id]')!.scrollIntoView = vi.fn();
    act(() => {
      jump('second');
      flushAnimationFrames();
      for (let frame = 1; frame <= 130; frame++) {
        top.set(frame * 20);
        flushAnimationFrames();
      }
      top.set(5000);
      for (let frame = 0; frame < 4; frame++) flushAnimationFrames();
    });
    expect(readChatScrollState(threadId)).toMatchObject({
      top: 5000,
      messageAnchor: { messageId: 'second', viewportOffsetPx: -100 },
    });
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
