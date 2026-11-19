// @vitest-environment jsdom
/**
 * Regression test for reconnect catch-up (#276 intake).
 *
 * When the server finishes processing during a socket disconnect,
 * done(isFinal) is lost. After reconnect, reconciliation detects
 * "server done but local had active invocations" and should trigger
 * requestStreamCatchUp so the user sees the response without F5.
 */
import EventEmitter from 'events';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock socket.io-client ──
const mockSocket = new EventEmitter() as EventEmitter & {
  id: string;
  io: { engine: { transport: { name: string }; on: () => void } };
  emit: (...args: unknown[]) => boolean;
  disconnect: () => void;
  connected: boolean;
};
mockSocket.id = 'mock-socket-id';
mockSocket.io = { engine: { transport: { name: 'websocket' }, on: vi.fn() } };
mockSocket.connected = true;
mockSocket.emit = vi.fn(() => true) as unknown as typeof mockSocket.emit;
mockSocket.disconnect = vi.fn();

vi.mock('socket.io-client', () => ({
  io: () => mockSocket,
}));

// ── Mock stores ──
const mockClearAllActiveInvocations = vi.fn();
const mockSetLoading = vi.fn();
const mockSetIntentMode = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetStreaming = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const neededReappeared = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockRefreshSidebarThreadSnapshot = vi.fn(() => Promise.resolve(true));
const mockGetThreadState = vi.fn(() => ({
  messages: [],
  isLoading: false,
  hasActiveInvocation: false,
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  unreadCount: 0,
  lastActivity: 0,
}));

const mockStoreState = {
  currentThreadId: 'thread-1',
  hasActiveInvocation: true,
  messages: [] as Array<{ id: string; type: string; isStreaming?: boolean }>,
  threadStates: {} as Record<string, { hasActiveInvocation: boolean }>,
  clearAllActiveInvocations: mockClearAllActiveInvocations,
  setLoading: mockSetLoading,
  setIntentMode: mockSetIntentMode,
  clearCatStatuses: mockClearCatStatuses,
  clearThreadCatStatuses: vi.fn(),
  setStreaming: mockSetStreaming,
  requestStreamCatchUp: mockRequestStreamCatchUp,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  getThreadState: mockGetThreadState,
  // Stubs for other store methods used during connect
  addMessageToThread: vi.fn(),
  appendToThreadMessage: vi.fn(),
  appendToolEventToThread: vi.fn(),
  setThreadCatInvocation: vi.fn(),
  setThreadMessageMetadata: vi.fn(),
  setThreadMessageUsage: vi.fn(),
  setThreadMessageStreaming: vi.fn(),
  setThreadLoading: vi.fn(),
  setThreadHasActiveInvocation: vi.fn(),
  setQueue: vi.fn(),
  setQueueFull: vi.fn(),
  setThreadIntentMode: vi.fn(),
  setThreadTargetCats: vi.fn(),
  updateThreadCatStatus: vi.fn(),
  replaceThreadTargetCats: vi.fn(),
  addActiveInvocation: vi.fn(),
  addThreadActiveInvocation: vi.fn(),
};

(globalThis as { __mockUseSocketStoreState?: typeof mockStoreState }).__mockUseSocketStoreState = mockStoreState;

vi.mock('@/stores/chatStore', () => {
  const getState = () =>
    (globalThis as { __mockUseSocketStoreState?: typeof mockStoreState }).__mockUseSocketStoreState!;
  const useChatStore = Object.assign(
    <T>(selector?: (state: typeof mockStoreState) => T) => {
      const state = getState();
      return selector ? selector(state) : state;
    },
    {
      getState,
    },
  );
  return { useChatStore };
});

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({
      addToast: vi.fn(),
    }),
  },
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'test-user',
}));

// Mock apiFetch to simulate server response
const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  refreshApiSession: vi.fn(async () => {}),
  API_URL: 'http://localhost:3100',
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  invalidateSidebarProjection: () => mockRefreshSidebarThreadSnapshot(),
}));

import { configureDebug } from '@/debug/invocationEventDebug';
import { type SocketCallbacks, useSocket } from '../useSocket';

function HookWrapper({ callbacks, threadId }: { callbacks: SocketCallbacks; threadId: string }) {
  useSocket(callbacks, threadId);
  return null;
}

describe('useSocket reconnect catch-up (#276 intake)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    vi.useFakeTimers();
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    vi.useRealTimers();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    delete (globalThis as { __mockUseSocketStoreState?: typeof mockStoreState }).__mockUseSocketStoreState;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    window.addEventListener('cat-cafe:socket-reconnected', neededReappeared);
    mockSocket.removeAllListeners();
    configureDebug({ enabled: false });

    // Default: store has active invocation (simulates "was processing before disconnect")
    mockStoreState.hasActiveInvocation = true;
    mockStoreState.messages = [];
    mockStoreState.threadStates = {};

    // Server says no active invocations (processing finished during disconnect)
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ activeInvocations: [] }),
    });
  });

  afterEach(() => {
    window.removeEventListener('cat-cafe:socket-reconnected', neededReappeared);
    act(() => {
      root.unmount();
    });
    container.remove();
    // Clean sessionStorage so joined-rooms state doesn't leak across tests
    window.sessionStorage.clear();
  });

  it('mounts when crypto.randomUUID is unavailable outside a secure context', () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
        randomUUID: undefined,
      },
    });

    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onIntentMode: vi.fn(),
    };

    try {
      expect(() => {
        act(() => {
          root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
        });
      }).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  it('triggers requestStreamCatchUp when server finished during disconnect', async () => {
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onIntentMode: vi.fn(),
    };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
    });

    // Simulate reconnect (fires 'connect' event)
    act(() => {
      const listeners = mockSocket.listeners('connect');
      for (const listener of listeners) {
        (listener as () => void)();
      }
    });

    // Advance past RECONNECT_RECONCILE_DELAY_MS (2000ms)
    await act(async () => {
      // Bounded advance past RECONNECT_RECONCILE_DELAY_MS (2000ms).
      // runAllTimersAsync would infinite-loop on the stale-watchdog setInterval.
      await vi.advanceTimersByTimeAsync(2500);
    });

    // Server had no active invocations → stale state cleared → catch-up triggered
    expect(mockClearThreadActiveInvocation).toHaveBeenCalledWith('thread-1');
    expect(mockClearAllActiveInvocations).not.toHaveBeenCalled();
    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
  });

  it('does NOT trigger catch-up when server still has active invocations', async () => {
    // Server says still processing
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ activeInvocations: [{ catId: 'opus', startedAt: Date.now() }] }),
    });

    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onIntentMode: vi.fn(),
    };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
    });

    act(() => {
      const listeners = mockSocket.listeners('connect');
      for (const listener of listeners) {
        (listener as () => void)();
      }
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    // Server still active → re-hydrate, don't catch-up via reconcile path
    // (NOTE: F183 follow-up adds an unconditional catch-up trigger on reconnect
    //  too — but only on RECONNECT, not the initial connect this test simulates.
    //  See "F183 follow-up: catch-up triggered on every reconnect" test below.)
    expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();
  });

  describe('canonical Sidebar snapshot reconnect recovery', () => {
    it('reappears needed sources once on reconnect, without a second sidebar pull', () => {
      mockStoreState.hasActiveInvocation = false;
      const callbacks: SocketCallbacks = { onMessage: vi.fn(), onIntentMode: vi.fn() };
      act(() => {
        root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
      });

      act(() => {
        for (const listener of mockSocket.listeners('connect')) {
          (listener as () => void)();
        }
      });
      expect(mockRefreshSidebarThreadSnapshot).not.toHaveBeenCalled();

      act(() => {
        for (const listener of mockSocket.listeners('connect')) {
          (listener as () => void)();
        }
      });
      expect(neededReappeared).toHaveBeenCalledTimes(1);
      expect(mockRefreshSidebarThreadSnapshot).not.toHaveBeenCalled();
    });

    it('invalidates the canonical sidebar snapshot when the document becomes visible', () => {
      const callbacks: SocketCallbacks = { onMessage: vi.fn(), onIntentMode: vi.fn() };
      act(() => {
        root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
      });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      expect(mockRefreshSidebarThreadSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  // F183 follow-up (R2/R4/R5 reconnect-window gap, 2026-05-02):
  // Server may broadcast agent_message during socket disconnect window.
  // Client missing the broadcast won't see the bubble until F5/thread-switch.
  // Phase C's gap detection only fires on next live event arrival; if the cat
  // finishes during disconnect and no further event arrives, gap is never
  // detected. Fix: trigger requestStreamCatchUp(threadId) on every RECONNECT
  // (not initial connect) — reuses Phase C catchup version + debounce + retry
  // + ack + Phase D merge filter machinery via useChatHistory subscription.
  describe('F183 follow-up: reconnect-window message catch-up', () => {
    it('does NOT trigger reconnect catch-up on initial connect', () => {
      mockStoreState.hasActiveInvocation = false; // no active state — triggers nothing in old reconcile path either

      const callbacks: SocketCallbacks = { onMessage: vi.fn(), onIntentMode: vi.fn() };
      act(() => {
        root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
      });

      // Fire connect for the FIRST time (initial connect, not a reconnect)
      act(() => {
        const listeners = mockSocket.listeners('connect');
        for (const listener of listeners) {
          (listener as () => void)();
        }
      });

      // Initial connect should NOT trigger catch-up — useChatHistory mount
      // already runs fetchHistory; double-firing would waste a server roundtrip.
      expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();
    });

    // PR-3a (contract 3.2/3.4): a reconnect rejoins every room; each thread room requests its
    // catch-up when the server confirms the rejoin, never before (an earlier read could predate it).
    const confirmLatestJoin = (room: string) => {
      const emitMock = mockSocket.emit as unknown as ReturnType<typeof vi.fn>;
      const ack = emitMock.mock.calls
        .filter(([event, joined]) => event === 'join_room' && joined === room)
        .map(([, , acknowledge]) => acknowledge as (ack: { ok: boolean; room: string }) => void)
        .at(-1);
      expect(ack, `a join_room request for ${room}`).toBeTypeOf('function');
      act(() => ack!({ ok: true, room }));
    };

    it('on every reconnect requests catch-up once the rejoin is confirmed', async () => {
      mockStoreState.hasActiveInvocation = false;

      const callbacks: SocketCallbacks = { onMessage: vi.fn(), onIntentMode: vi.fn() };
      act(() => {
        root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
      });

      // First connect — initial, no catch-up
      act(() => {
        const listeners = mockSocket.listeners('connect');
        for (const listener of listeners) {
          (listener as () => void)();
        }
      });
      expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();

      // Second connect — RECONNECT. It still covers the reported "F5 / 切 thread 才出来"
      // scenario (a broadcast inside the disconnect window that no later live event
      // reveals), regardless of local active-invocation state, but only from the rejoin.
      act(() => {
        const listeners = mockSocket.listeners('connect');
        for (const listener of listeners) {
          (listener as () => void)();
        }
      });
      expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();
      confirmLatestJoin('thread:thread-1');
      expect(mockRequestStreamCatchUp).toHaveBeenCalledExactlyOnceWith('thread-1');
    });

    // PR-3b: only foreground threads have rooms, so a reconnect catches up only those; an earlier
    // page's background rooms (saved by an older build in sessionStorage) are neither rejoined nor read.
    it('reconnect catch-up covers the foreground room and no background thread', () => {
      mockStoreState.hasActiveInvocation = false;
      mockStoreState.threadStates = {};
      window.sessionStorage.setItem(
        'cat-cafe:ws:joined-rooms:v1:test-user',
        JSON.stringify(['thread:thread-1', 'thread:thread-bg-1', 'thread:thread-bg-2']),
      );

      const callbacks: SocketCallbacks = { onMessage: vi.fn(), onIntentMode: vi.fn() };
      act(() => {
        root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
      });
      act(() => {
        for (const listener of mockSocket.listeners('connect')) (listener as () => void)();
      });
      mockRequestStreamCatchUp.mockClear();
      const emitMock = mockSocket.emit as unknown as ReturnType<typeof vi.fn>;
      emitMock.mockClear();

      act(() => {
        for (const listener of mockSocket.listeners('connect')) (listener as () => void)();
      });
      const rejoined = emitMock.mock.calls.filter(([event]) => event === 'join_room').map(([, room]) => room);
      expect(new Set(rejoined)).toEqual(new Set(['thread:thread-1']));

      confirmLatestJoin('thread:thread-1');
      expect(mockRequestStreamCatchUp.mock.calls.map((c) => c[0])).toEqual(['thread-1']);
    });
  });
});
