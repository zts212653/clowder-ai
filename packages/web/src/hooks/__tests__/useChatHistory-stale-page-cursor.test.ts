// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatStore } from '@/stores/chatStore';
import { beginThreadRecovery } from '@/stores/thread-recovery';
import { apiFetch } from '@/utils/api-client';
import { __resetChatScrollMemoryForTest, saveChatScrollState } from '@/utils/chat-scroll-memory';
import { __resetPendingTeleportForTest, peekPendingTeleport, setPendingTeleport } from '@/utils/teleport';
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
  return React.createElement('div', { ref: hook.scrollContainerRef });
}
function Host({ threadId }: { threadId: string }) {
  return React.createElement(ThreadChatHistoryAdmissionProvider, null, React.createElement(Probe, { threadId }));
}

/** A server transcript of `total` messages, oldest first: m0 is the very first message of the thread. */
function transcript(total: number) {
  return Array.from({ length: total }, (_, index) => ({
    id: `m${String(index).padStart(3, '0')}`,
    type: 'assistant' as const,
    catId: 'opus',
    content: `message ${index}`,
    timestamp: 1000 + index,
  }));
}
type ServerMessage = ReturnType<typeof transcript>[number];
const cursorOf = (message: ServerMessage) => `${message.timestamp}:${message.id}`;
function at(messages: readonly ServerMessage[], index: number): ServerMessage {
  const found = messages.at(index);
  if (!found) throw new Error(`No message at ${index}`);
  return found;
}

describe('history page cursor after a recovery read unloads older pages', () => {
  let root: Root;
  let container: HTMLElement;
  let server: ServerMessage[];
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;

  /** The history API: `before` pages end just under that cursor; no `before` is the latest page. */
  function serveHistory(limit = 50) {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (!path.startsWith('/api/messages')) {
        return { ok: true, json: async () => ({ tasks: [], queue: [] }) } as Response;
      }
      const before = new URL(path, 'http://localhost').searchParams.get('before');
      const older = before ? server.filter((message) => cursorOf(message) < before) : server;
      const page = older.slice(-limit);
      return {
        ok: true,
        json: async () => ({
          messages: page,
          hasMore: older.length > page.length,
          historyPageCursor: page[0] ? cursorOf(page[0]) : null,
        }),
      } as Response;
    });
  }
  const beforeCursorsRequested = () =>
    vi
      .mocked(apiFetch)
      .mock.calls.map(([path]) => new URL(String(path), 'http://localhost').searchParams.get('before'))
      .filter((before): before is string => before !== null);

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

  function flushFrames(times = 4) {
    for (let n = 0; n < times; n++) {
      const callbacks = [...frames.values()];
      frames.clear();
      act(() => {
        for (const cb of callbacks) cb(16);
      });
    }
  }
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    flushFrames();
  }
  async function openThread(threadId: string) {
    useChatStore.getState().setCurrentThread(threadId);
    await act(async () => root.render(React.createElement(Host, { threadId })));
    await settle();
  }
  /** Leave the thread and come back with `unreadCount` set, so the return refreshes it with a replace read. */
  async function leaveAndReturn(threadId: string, options: { roomRecovery: boolean; beforeReturn?: () => void }) {
    act(() => root.unmount());
    root = createRoot(container);
    useChatStore.getState().setCurrentThread('elsewhere');
    expect(useChatStore.getState().threadStates[threadId]?.messages.length).toBeGreaterThan(0);
    useChatStore.setState((state) => {
      const cached = state.threadStates[threadId];
      if (!cached) throw new Error(`No cached state for ${threadId}`);
      return { threadStates: { ...state.threadStates, [threadId]: { ...cached, unreadCount: 1 } } };
    });
    if (options.roomRecovery) beginThreadRecovery(threadId);
    options.beforeReturn?.();
    await openThread(threadId);
  }
  function scrollToTop() {
    const el = hook.scrollContainerRef.current;
    if (!el) throw new Error('Missing chat viewport');
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 0, writable: true });
    act(() => hook.handleScroll());
  }

  it('pages up from the oldest loaded message, not from a first message the recovery read unloaded', async () => {
    const T = 'stale-cursor-recovery';
    // The thread was short and fully loaded: its first message m000 is the page boundary.
    server = transcript(5);
    serveHistory();
    await openThread(T);
    const first = at(server, 0);
    expect(
      useChatStore
        .getState()
        .getThreadState(T)
        .messages.map((message) => message.id),
    ).toContain(first.id);

    // The thread grows past one page while this page is away; the return runs a room recovery round.
    server = transcript(67);
    await leaveAndReturn(T, { roomRecovery: true });
    const loaded = useChatStore.getState().getThreadState(T).messages;
    const latestPage = server.slice(-50);
    expect(loaded.map((message) => message.id)).toEqual(latestPage.map((message) => message.id));

    scrollToTop();
    await settle();

    // The older pages (m000..m016) are fetched again from where the loaded page starts.
    expect(beforeCursorsRequested()).toEqual([cursorOf(at(latestPage, 0))]);
    expect(
      useChatStore
        .getState()
        .getThreadState(T)
        .messages.map((message) => message.id),
    ).toEqual(server.map((message) => message.id));
    expect(useChatStore.getState().getThreadState(T).hasMore).toBe(false);
  });

  it('keeps the deeper boundary when the replace read leaves the older loaded pages in place', async () => {
    const T = 'stale-cursor-retained';
    server = transcript(5);
    serveHistory();
    await openThread(T);
    const first = at(server, 0);

    // Same growth, but no recovery round: nothing marks the cached older pages as undecided,
    // so the replace read merges the latest page into them and m000..m004 stay loaded.
    server = transcript(67);
    await leaveAndReturn(T, { roomRecovery: false });
    const loaded = useChatStore
      .getState()
      .getThreadState(T)
      .messages.map((message) => message.id);
    expect(loaded).toContain(first.id);

    scrollToTop();
    await settle();

    // The boundary of what is loaded is still the first message; the replace read must not move it.
    expect(beforeCursorsRequested()).toEqual([cursorOf(first)]);
  });

  it('lets a teleport to an unloaded older message page up from the loaded page, not from the unloaded first message', async () => {
    const T = 'stale-cursor-teleport';
    server = transcript(5);
    serveHistory();
    await openThread(T);

    server = transcript(67);
    const target = at(server, 10);
    await leaveAndReturn(T, {
      roomRecovery: true,
      beforeReturn: () => setPendingTeleport({ threadId: T, messageId: target.id }),
    });
    await settle();

    expect(beforeCursorsRequested()[0]).toBe(cursorOf(at(server.slice(-50), 0)));
    expect(
      useChatStore
        .getState()
        .getThreadState(T)
        .messages.map((message) => message.id),
    ).toContain(target.id);
    expect(peekPendingTeleport(T)).toBeNull();
  });

  it('recovers a reading anchor in the unloaded older range by paging up from the loaded page', async () => {
    const T = 'stale-cursor-reading-anchor';
    server = transcript(5);
    serveHistory();
    await openThread(T);

    server = transcript(67);
    const anchor = at(server, 10);
    await leaveAndReturn(T, {
      roomRecovery: true,
      beforeReturn: () =>
        saveChatScrollState(T, {
          top: 400,
          anchor: 'offset',
          messageAnchor: { messageId: anchor.id, viewportOffsetPx: -20, timelineOrderAt: anchor.timestamp },
        }),
    });
    await settle();

    expect(beforeCursorsRequested()[0]).toBe(cursorOf(at(server.slice(-50), 0)));
    expect(
      useChatStore
        .getState()
        .getThreadState(T)
        .messages.map((message) => message.id),
    ).toContain(anchor.id);
  });
});
