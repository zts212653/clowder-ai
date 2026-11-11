// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CHAT_READING_INPUT_FENCE_EVENT, readChatReadingInputFenceRequest } from '@/utils/chat-reading-input-fence';
import { __resetChatScrollMemoryForTest, readChatReadingRef } from '@/utils/chat-scroll-memory';
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
function Reader() {
  hook = useChatHistory('short');
  return <div ref={hook.scrollContainerRef} />;
}
const message = {
  id: 'original',
  timestamp: 100,
  type: 'assistant' as const,
  catId: 'opus',
  content: 'Short original',
};

describe('bottom restore on a short reading surface', () => {
  let root: Root, container: HTMLElement, el: HTMLDivElement;
  const frames = new Map<number, FrameRequestCallback>();
  let seq = 0;
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
    localStorage.clear();
    __resetChatScrollMemoryForTest();
    frames.clear();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.set(++seq, cb);
      return seq;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [message], hasMore: false, tasks: [], queue: [], activeInvocations: [] }),
    } as Response);
    useChatStore.setState({
      currentThreadId: 'short',
      threadStates: {},
      messages: [],
      isLoadingHistory: false,
      hasMore: false,
    });
    useChatStore.getState().replaceThreadMessages('short', [message], false);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <ThreadChatHistoryAdmissionProvider>
          <Reader />
        </ThreadChatHistoryAdmissionProvider>,
      ),
    );
    const viewport = hook.scrollContainerRef.current;
    if (!viewport) throw new Error('Missing reader viewport');
    el = viewport;
    dimensions(600, 600);
    await flush();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.mocked(apiFetch).mockReset();
    __resetChatScrollMemoryForTest();
  });
  function dimensions(scrollHeight: number, clientHeight: number) {
    let top = 0;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: scrollHeight },
      clientHeight: { configurable: true, value: clientHeight },
      scrollTop: {
        configurable: true,
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, scrollHeight - clientHeight));
        },
      },
    });
    el.getBoundingClientRect = () => ({ top: 0, bottom: clientHeight, height: clientHeight }) as DOMRect;
  }
  async function flush(count = 120) {
    for (let i = 0; i < count; i++)
      await act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((cb) => {
          cb(i * 16);
        });
        await Promise.resolve();
      });
  }
  function restore() {
    const captured = hook.captureReadingRef();
    if (!captured) throw new Error('Failed to capture the original reader');
    expect(captured?.persisted).toBe(true);
    expect(readChatReadingRef(captured.ref)).toEqual({
      threadId: 'short',
      position: { anchor: 'bottom', top: el.scrollTop },
    });
    let result: Awaited<ReturnType<typeof hook.restoreReadingRef>> | undefined;
    act(() => {
      void hook.restoreReadingRef(captured.ref).then((receipt) => {
        result = receipt;
      });
    });
    return { captured, result: () => result };
  }

  it.each([600, 1600])('certifies the real captured bottom with scrollHeight=%s', async (height) => {
    dimensions(height, 600);
    el.scrollTop = height - 600;
    const state = restore();
    await flush();
    expect(state.result()).toEqual({
      status: 'settled',
      exact: true,
      position: { anchor: 'bottom', top: height - 600 },
    });
    expect(readChatReadingRef(state.captured.ref)).toBeDefined(); // Only the consumer may consume its source.
  });

  it('does not certify an unmeasured zero-height viewport at top zero', async () => {
    dimensions(0, 0);
    const state = restore();
    await flush();
    expect(state.result()).toEqual({ status: 'unavailable' });
    expect(readChatReadingRef(state.captured.ref)).toBeDefined();
  });

  it('waits for the viewport to become measurable within the existing restore budget', async () => {
    dimensions(0, 0);
    const state = restore();
    await flush(2);
    expect(state.result()).toBeUndefined();
    dimensions(600, 600);
    await flush();
    expect(state.result()).toEqual({ status: 'settled', exact: true, position: { anchor: 'bottom', top: 0 } });
  });

  it('rechecks measurable bottom after the input fence, rather than consuming a hidden owner', async () => {
    let finish!: (confirmed: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const enroll = (event: Event) => readChatReadingInputFenceRequest(event)?.enroll({ result, cancel: () => {} });
    window.addEventListener(CHAT_READING_INPUT_FENCE_EVENT, enroll);
    try {
      const state = restore();
      await flush(2);
      expect(state.result()).toBeUndefined();
      // The captured short-page top (zero) would still match hidden geometry.
      dimensions(0, 0);
      await act(async () => finish(true));
      await flush();
      expect(state.result()).toEqual({ status: 'unavailable' });
      expect(readChatReadingRef(state.captured.ref)).toBeDefined();
    } finally {
      window.removeEventListener(CHAT_READING_INPUT_FENCE_EVENT, enroll);
    }
  });

  it.each([
    'loading',
    'offline',
  ] as const)('waits for fresh history rather than certifying %s geometry', async (phase) => {
    act(() => {
      if (phase === 'loading') useChatStore.getState().setThreadLoadingHistory('short', true);
      else
        useChatStore.setState((s) => ({
          threadStates: { ...s.threadStates, short: { ...s.getThreadState('short'), isOfflineSnapshot: true } },
          isOfflineSnapshot: true,
        }));
    });
    const state = restore();
    await flush();
    expect(state.result()).toBeUndefined();
    act(() => {
      if (phase === 'loading') useChatStore.getState().setThreadLoadingHistory('short', false);
      else
        useChatStore.setState((s) => ({
          threadStates: { ...s.threadStates, short: { ...s.getThreadState('short'), isOfflineSnapshot: false } },
          isOfflineSnapshot: false,
        }));
    });
    await flush();
    expect(state.result()).toEqual({ status: 'settled', exact: true, position: { anchor: 'bottom', top: 0 } });
  });
});
