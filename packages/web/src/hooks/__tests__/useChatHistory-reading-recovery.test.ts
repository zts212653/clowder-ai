import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { type ChatMessage, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { __resetChatScrollMemoryForTest, readChatScrollState, saveChatScrollState } from '@/utils/chat-scroll-memory';
import { __resetPendingTeleportForTest, setPendingTeleport } from '@/utils/teleport';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/offline-store', () => ({
  loadThreadMessages: vi.fn().mockResolvedValue(null),
  saveThreadMessages: vi.fn().mockResolvedValue(undefined),
  loadThreadActiveState: vi.fn().mockResolvedValue(null),
  saveThreadActiveState: vi.fn().mockResolvedValue(undefined),
  loadThreadWorkspaceState: vi.fn().mockResolvedValue(null),
}));

let hook: ReturnType<typeof useChatHistory>;
function Probe({ threadId }: { threadId: string }) {
  hook = useChatHistory(threadId);
  return React.createElement(
    'div',
    { ref: hook.scrollContainerRef },
    React.createElement('div', { ref: hook.messagesEndRef }),
  );
}
function Host({ threadId }: { threadId: string }) {
  return React.createElement(ThreadChatHistoryAdmissionProvider, null, React.createElement(Probe, { threadId }));
}
const message = (id: string, timestamp: number) => ({
  id,
  timestamp,
  type: 'assistant' as const,
  catId: 'opus',
  content: id,
});

function geometry(el: HTMLElement, initialTop = 0) {
  let top = initialTop;
  Object.defineProperties(el, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    },
    scrollHeight: { configurable: true, value: 1600 },
    clientHeight: { configurable: true, value: 600 },
  });
  el.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
  return () => top;
}
function boundary(el: HTMLElement, id: string, contentTop: number, top: () => number) {
  const node = document.createElement('div');
  node.dataset.messageViewportId = id;
  node.getBoundingClientRect = () => ({ top: 100 + contentTop - top(), bottom: 300 + contentTop - top() }) as DOMRect;
  const body = document.createElement('div');
  body.dataset.messageId = id;
  body.scrollIntoView = vi.fn();
  node.append(body);
  el.append(node);
  return body;
}

describe('reading recovery across cold history and obsolete callbacks', () => {
  let root: Root, container: HTMLElement;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    __resetChatScrollMemoryForTest();
    frames.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], tasks: [], hasMore: false }),
    } as Response);
    useChatStore.setState({
      currentThreadId: 'default',
      messages: [],
      threadStates: {},
      isLoadingHistory: false,
      hasMore: false,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.mocked(apiFetch).mockReset();
    __resetPendingTeleportForTest();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  function flush() {
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => {
      for (const cb of callbacks) cb(16);
    });
  }
  async function mount(threadId: string, messages: ChatMessage[] = [message('reading', 100)], hasMore = false) {
    useChatStore.getState().setCurrentThread(threadId);
    useChatStore.getState().replaceThreadMessages(threadId, messages, hasMore);
    useChatStore.getState().setThreadLoadingHistory(threadId, false);
    await act(async () => root.render(React.createElement(Host, { threadId })));
    const el = hook.scrollContainerRef.current;
    if (!el) throw new Error('Missing chat viewport');
    if (hook.messagesEndRef.current) hook.messagesEndRef.current.scrollIntoView = vi.fn();
    return { el, top: geometry(el) };
  }

  it('restores the persisted message offset in a cold page, without copying message content', async () => {
    saveChatScrollState('cold', {
      top: 400,
      anchor: 'offset',
      messageAnchor: { messageId: 'reading', viewportOffsetPx: -20 },
    });
    __resetChatScrollMemoryForTest();
    const { el, top } = await mount('cold');
    boundary(el, 'reading', 380, top);
    flush();
    expect(top()).toBe(400);
    expect(readChatScrollState('cold')).toEqual({
      top: 400,
      anchor: 'offset',
      messageAnchor: { messageId: 'reading', viewportOffsetPx: -20, timelineOrderAt: 100 },
    });
    expect(localStorage.getItem('cat-cafe:thread-scroll:cold')).not.toContain('content');
  });

  it('loads older history for a persisted anchor outside the latest page', async () => {
    saveChatScrollState('paged', {
      top: 400,
      anchor: 'offset',
      messageAnchor: { messageId: 'older-reading', viewportOffsetPx: -20, timelineOrderAt: 1 },
    });
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: async () =>
            path.startsWith('/api/messages')
              ? { messages: [message('older-reading', 1)], hasMore: false }
              : { tasks: [], activeInvocations: [] },
        }) as Response,
    );
    const { el, top } = await mount('paged', [message('latest', 100)], true);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(([path]) => path.startsWith('/api/messages') && path.includes('before=100%3Alatest')),
    ).toBe(true);
    boundary(el, 'older-reading', 380, top);
    for (let n = 0; n < 5; n++) flush();
    expect(top()).toBe(400);
  });

  it('keeps a read streaming bubble anchored when the message owner replaces its id', async () => {
    const streaming = {
      ...message('stream-placeholder', 100),
      isStreaming: true,
      extra: { stream: { turnInvocationId: 'reading-turn' } },
    };
    const { el, top } = await mount('rekeyed', [{ ...streaming, isStreaming: false }]);
    act(() => useChatStore.getState().patchMessage(streaming.id, { isStreaming: true, origin: 'stream' }));
    el.scrollTop = 400;
    boundary(el, streaming.id, 380, top);
    act(() => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })));
    act(() => hook.handleScroll());
    act(() => useChatStore.getState().replaceMessageId(streaming.id, 'stored-message'));
    expect(readChatScrollState('rekeyed')).toMatchObject({
      anchor: 'offset',
      messageAnchor: { messageId: 'stored-message', viewportOffsetPx: -20 },
    });
    __resetChatScrollMemoryForTest();
    expect(readChatScrollState('rekeyed')?.anchor).toBe('offset');
    expect(readChatScrollState('rekeyed')).toMatchObject({ messageAnchor: { messageId: 'stored-message' } });
  });

  it.each([
    95,
    undefined,
    1000,
  ])('bounds an unavailable anchor at timeline %s without applying another window pixel offset', async (timelineOrderAt) => {
    localStorage.setItem(
      'cat-cafe:thread-scroll:deleted',
      JSON.stringify({
        v: 1,
        state: {
          top: 900,
          anchor: 'offset',
          messageAnchor: { messageId: 'deleted', viewportOffsetPx: -20, timelineOrderAt },
        },
      }),
    );
    let pages = 0;
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: async () =>
            path.startsWith('/api/messages')
              ? { messages: [message(`older-${++pages}`, 100 - pages * 20)], hasMore: pages < 8 }
              : { tasks: [], activeInvocations: [] },
        }) as Response,
    );
    const { el, top } = await mount('deleted', [message('latest', 100)], true);
    boundary(el, 'latest', 380, top);
    const short = timelineOrderAt === 1000;
    if (short) Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 600 });
    el.scrollTop = short ? 0 : 200;
    for (let n = 0; n < 12; n++) {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      flush();
    }
    expect(pages).toBe(timelineOrderAt === 95 ? 1 : 0);
    expect(top()).toBe(short ? 0 : timelineOrderAt === undefined ? 1000 : 400);
    __resetChatScrollMemoryForTest();
    expect(readChatScrollState('deleted')).toMatchObject(
      timelineOrderAt !== 95
        ? { anchor: 'bottom' }
        : { messageAnchor: { messageId: 'latest', viewportOffsetPx: -20, timelineOrderAt: 100 } },
    );
  });

  it('pages through an equal-score boundary using the owner composite cursor', async () => {
    saveChatScrollState('tied', {
      top: 400,
      anchor: 'offset',
      messageAnchor: {
        messageId: 'message-2',
        viewportOffsetPx: -20,
        timelineOrderAt: 100,
      },
    });
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: async () =>
            path.startsWith('/api/messages')
              ? { messages: [message('message-1', 100), message('message-2', 100)], hasMore: false }
              : { tasks: [], activeInvocations: [] },
        }) as Response,
    );
    const { el, top } = await mount('tied', [message('message-3', 100)], true);
    boundary(el, 'message-2', 380, top);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    flush();
    expect(top()).toBe(400);
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes('before=100%3Amessage-3'))).toBe(true);
  });

  it('retries a present reading anchor instead of accepting a clamped pixel substitute', async () => {
    saveChatScrollState('clamped', {
      top: 200,
      anchor: 'offset',
      messageAnchor: { messageId: 'reading', viewportOffsetPx: -20 },
    });
    const { el } = await mount('clamped');
    let top = 0;
    let max = 400;
    Object.defineProperties(el, {
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.min(value, max);
        },
      },
      scrollHeight: { configurable: true, get: () => max + 600 },
    });
    boundary(el, 'reading', 580, () => top);
    flush();
    expect(top).toBe(400);
    max = 1000;
    flush();
    expect(top).toBe(600);
    expect(readChatScrollState('clamped')?.top).toBe(600);
  });

  it('does not let an obsolete same-thread restore undo jump-to-latest', async () => {
    saveChatScrollState('obsolete', {
      top: 400,
      anchor: 'offset',
      messageAnchor: { messageId: 'reading', viewportOffsetPx: -20 },
    });
    const { el, top } = await mount('obsolete');
    boundary(el, 'reading', 380, top);
    const obsolete = [...frames.values()][0];
    expect(obsolete).toBeDefined();
    const end = hook.messagesEndRef.current;
    if (!end) throw new Error('Missing chat tail');
    end.scrollIntoView = vi.fn(() => {
      el.scrollTop = 1000;
    });
    act(() => hook.jumpToLatest());
    act(() => obsolete(16));
    expect(top()).toBe(1000);
    expect(readChatScrollState('obsolete')?.anchor).toBe('bottom');
  });

  it('gives a pending teleport precedence over disk reading state', async () => {
    saveChatScrollState('teleport', {
      top: 400,
      anchor: 'offset',
      messageAnchor: { messageId: 'reading', viewportOffsetPx: -20 },
    });
    setPendingTeleport({ threadId: 'teleport', messageId: 'chosen' });
    const { el, top } = await mount('teleport', [message('reading', 100), message('chosen', 200)]);
    boundary(el, 'reading', 380, top);
    const target = boundary(el, 'chosen', 900, top);
    target.scrollIntoView = vi.fn(() => {
      el.scrollTop = 800;
    });
    for (let n = 0; n < 6; n++) flush();
    expect(top()).toBe(800);
    expect(readChatScrollState('teleport')).toMatchObject({ anchor: 'offset', messageAnchor: { messageId: 'chosen' } });
  });
});
