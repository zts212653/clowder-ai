import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { type ChatMessage, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CHAT_LAYOUT_CHANGED_EVENT } from '@/utils/chat-layout-change';
import {
  __resetChatScrollMemoryForTest,
  captureChatReadingRef,
  readChatReadingRef,
  readChatScrollState,
  type SavedScrollState,
  saveChatScrollState,
} from '@/utils/chat-scroll-memory';
import { loadThreadMessages } from '@/utils/offline-store';
import { MESSAGE_VIEWPORT_MOUNTED_EVENT } from '@/utils/scrollToMessage';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/offline-store', () => ({
  loadThreadMessages: vi.fn(),
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
const messages: ChatMessage[] = [
  { id: 'reading', timestamp: 100, type: 'assistant', catId: 'opus', content: 'cached reading' },
  { id: 'latest', timestamp: 200, type: 'assistant', catId: 'opus', content: 'latest' },
];
const offset: SavedScrollState = {
  top: 400,
  anchor: 'offset',
  messageAnchor: { messageId: 'reading', viewportOffsetPx: -20, timelineOrderAt: 100 },
};

describe('cached visual restore before authoritative history settlement', () => {
  let root: Root, container: HTMLElement;
  let releaseHistory: () => void;
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
    vi.mocked(loadThreadMessages).mockResolvedValue(null);
    useChatStore.setState({
      currentThreadId: 'default',
      messages: [],
      threadStates: {},
      isLoadingHistory: false,
      hasMore: false,
      isOfflineSnapshot: false,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    act(() => root.unmount());
    releaseHistory?.();
    await Promise.resolve();
    container.remove();
    vi.unstubAllGlobals();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(loadThreadMessages).mockReset();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function flush(count = 1) {
    for (let n = 0; n < count; n++) {
      await act(async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const cb of callbacks) cb(16);
        await Promise.resolve();
      });
    }
  }
  async function open(source: 'cache' | 'idb', saved: SavedScrollState) {
    const threadId = `pending-${source}`;
    const gate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path.startsWith('/api/messages')) await gate;
      return {
        ok: true,
        json: async () =>
          path.startsWith('/api/messages') ? { messages, hasMore: false } : { tasks: [], activeInvocations: [] },
      } as Response;
    });
    saveChatScrollState(threadId, saved);
    useChatStore.getState().setCurrentThread(threadId);
    if (source === 'cache') {
      useChatStore.getState().replaceThreadMessages(threadId, messages, false);
      const state = useChatStore.getState();
      useChatStore.setState({
        threadStates: { ...state.threadStates, [threadId]: { ...state.getThreadState(threadId), unreadCount: 2 } },
      });
    } else {
      vi.mocked(loadThreadMessages).mockResolvedValue({ messages, hasMore: false, updatedAt: 1 });
    }
    await act(async () =>
      root.render(
        React.createElement(ThreadChatHistoryAdmissionProvider, null, React.createElement(Probe, { threadId })),
      ),
    );
    expect(useChatStore.getState().isLoadingHistory).toBe(true);
    expect(useChatStore.getState().isOfflineSnapshot).toBe(source === 'idb');
    const el = hook.scrollContainerRef.current!;
    let top = 0;
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
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'reading';
    boundary.getBoundingClientRect = () => ({ top: 480 - top, bottom: 680 - top }) as DOMRect;
    const body = document.createElement('div');
    body.dataset.messageId = 'reading';
    boundary.append(body);
    el.append(boundary);
    return { threadId, el, top: () => top };
  }
  async function settleHistory() {
    await act(async () => {
      releaseHistory();
      await Promise.resolve();
    });
    expect(useChatStore.getState().isLoadingHistory).toBe(false);
    expect(useChatStore.getState().isOfflineSnapshot).toBe(false);
    await flush(5);
  }

  for (const source of ['cache', 'idb'] as const) {
    it.each([
      ['bottom', { top: 1000, anchor: 'bottom' }],
      ['message offset', offset],
    ] as const)(`restores %s from ${source} while the revalidation request is pending`, async (_label, saved) => {
      const { top, threadId } = await open(source, saved);
      await flush(6);
      expect(useChatStore.getState().isLoadingHistory).toBe(true);
      expect(top()).toBe(saved.top);
      expect(readChatScrollState(threadId)).toMatchObject(saved);
      await settleHistory();
      expect(top()).toBe(saved.top);
    });
    it(`shows the available ${source} anchor but keeps the return receipt pending through layout events`, async () => {
      const { top, threadId } = await open(source, offset);
      let receipt!: ReturnType<typeof hook.restoreReadingPosition>;
      act(() => {
        receipt = hook.restoreReadingPosition({ threadId, position: offset });
      });
      const resolved = vi.fn();
      void receipt.then(resolved);
      await flush(100);
      expect(top()).toBe(400);
      act(() => window.dispatchEvent(new Event(CHAT_LAYOUT_CHANGED_EVENT)));
      await flush(3);
      expect(resolved).not.toHaveBeenCalled();
      act(() => window.dispatchEvent(new Event(MESSAGE_VIEWPORT_MOUNTED_EVENT)));
      await flush(3);
      expect(resolved).not.toHaveBeenCalled();
      await settleHistory();
      expect(await receipt).toMatchObject({ status: 'settled', exact: true, position: offset });
    });
    it.each([
      'available bottom',
      'missing message',
    ] as const)(`lets a widget click replace the ${source} %s return intent while history is pending`, async (intent) => {
      const { el, threadId, top } = await open(source, { top: 1000, anchor: 'bottom' });
      await flush(6);
      const position: SavedScrollState =
        intent === 'available bottom'
          ? { top: 1000, anchor: 'bottom' }
          : {
              top: 400,
              anchor: 'offset',
              messageAnchor: { messageId: 'older-reading', viewportOffsetPx: -20, timelineOrderAt: 1 },
            };
      const origin = captureChatReadingRef({ threadId, position })!;
      let receipt!: ReturnType<typeof hook.restoreReadingRef>;
      act(() => {
        receipt = hook.restoreReadingRef(origin.ref);
      });
      await flush(100);
      const clicked = document.createElement('div');
      clicked.dataset.messageViewportId = 'latest';
      clicked.getBoundingClientRect = () => ({ top: 1300 - top(), bottom: 1500 - top() }) as DOMRect;
      el.append(clicked);
      // The clicked widget moved from y=500 to y=300 as it changed height.
      act(() =>
        window.dispatchEvent(
          new CustomEvent(CHAT_LAYOUT_CHANGED_EVENT, {
            detail: { viewportAnchor: { element: clicked, viewportTop: 500, fallbackScrollTop: 1000 } },
          }),
        ),
      );
      await flush(3);
      expect(top()).toBe(800);
      expect(await receipt).toEqual({ status: 'interrupted' });
      expect(clicked.getBoundingClientRect().top).toBe(500);
      expect(readChatScrollState(threadId)).toMatchObject({
        top: 800,
        anchor: 'offset',
        messageAnchor: { messageId: 'latest' },
      });
      expect(readChatReadingRef(origin.ref)).toEqual({ threadId, position });
      await settleHistory();
      expect(top()).toBe(800);
      expect(readChatReadingRef(origin.ref)).toEqual({ threadId, position });
    });
    it(`lets user input interrupt the visually restored ${source} receipt before revalidation`, async () => {
      const { el, threadId } = await open(source, offset);
      let receipt!: ReturnType<typeof hook.restoreReadingPosition>;
      act(() => {
        receipt = hook.restoreReadingPosition({ threadId, position: offset });
      });
      await flush(2);
      act(() => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })));
      expect(await receipt).toEqual({ status: 'interrupted' });
      await settleHistory();
    });
    it(`retires queued ${source} restore writes at pointerdown, including stale RAF delivery`, async () => {
      const { el, threadId, top } = await open(source, offset);
      let receipt!: ReturnType<typeof hook.restoreReadingPosition>;
      act(() => {
        receipt = hook.restoreReadingPosition({ threadId, position: offset });
      });
      const obsoleteFrames = [...frames.values()];
      expect(obsoleteFrames.length).toBeGreaterThan(0);
      const beforePointerDown = top();
      const writes = vi.spyOn(el, 'scrollTop', 'set');
      act(() => el.dispatchEvent(new MouseEvent('pointerdown', { clientY: 150, bubbles: true })));
      expect(await receipt).toEqual({ status: 'interrupted' });
      // A callback already queued for delivery must also lose its old ownership.
      act(() => {
        for (const callback of obsoleteFrames) callback(16);
      });
      await flush(3);
      expect(writes).not.toHaveBeenCalled();
      expect(top()).toBe(beforePointerDown);
      await settleHistory();
      expect(writes).not.toHaveBeenCalled();
      expect(top()).toBe(beforePointerDown);
    });
    it(`does not certify a ${source} layout miss while authoritative history is still pending`, async () => {
      const { el, threadId, top } = await open(source, offset);
      const scrollTop = Object.getOwnPropertyDescriptor(el, 'scrollTop')!;
      Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => 0, set: () => {} });
      let receipt!: ReturnType<typeof hook.restoreReadingPosition>;
      act(() => {
        receipt = hook.restoreReadingPosition({ threadId, position: offset });
      });
      const resolved = vi.fn();
      void receipt.then(resolved);
      await flush(100);
      expect(resolved).not.toHaveBeenCalled();
      Object.defineProperty(el, 'scrollTop', scrollTop);
      await settleHistory();
      expect(top()).toBe(400);
      expect(await receipt).toMatchObject({ status: 'settled', exact: true });
    });
  }
});
