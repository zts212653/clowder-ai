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
const mockClearThreadActiveInvocation = vi.fn();
const mockGetThreadState = vi.fn(() => ({
  messages: [],
  isLoading: false,
  hasActiveInvocation: false,
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  currentGame: null,
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
  setQueuePaused: vi.fn(),
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
  API_URL: 'http://localhost:3100',
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// Mock game reconnect
vi.mock('../useGameReconnect', () => ({
  reconnectGame: vi.fn(() => Promise.resolve()),
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
    act(() => {
      root.unmount();
    });
    container.remove();
    // Clean sessionStorage so joined-rooms state doesn't leak across tests
    window.sessionStorage.clear();
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

    it('DOES trigger reconnect catch-up on every subsequent connect (RECONNECT semantic)', async () => {
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

      // Second connect — RECONNECT; should trigger catch-up regardless of
      // local active-invocation state. This covers the user's reported
      // "F5 / 切 thread 才出来" scenario: server broadcast a message during
      // the disconnect window, client never saw it, no live event triggers
      // gap detection, so we proactively refetch on reconnect.
      act(() => {
        const listeners = mockSocket.listeners('connect');
        for (const listener of listeners) {
          (listener as () => void)();
        }
      });
      expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
    });

    it('reconnect catch-up also covers joined background thread rooms', () => {
      mockStoreState.hasActiveInvocation = false;
      mockStoreState.threadStates = {};
      // Cloud R1 P1: joined rooms come from joinedRoomsRef (loaded from
      // sessionStorage at hook mount), NOT threadStates. Pre-seed
      // sessionStorage so bg rooms are present in joinedRoomsRef before
      // the first connect handler runs. This mirrors the production
      // scenario: user previously joined bg threads → rooms persisted to
      // session → reload restores joined-rooms set → reconnect should
      // catch-up all of them, not just the currently-mounted active thread.
      window.sessionStorage.setItem(
        'cat-cafe:ws:joined-rooms:v1:test-user',
        JSON.stringify(['thread:thread-1', 'thread:thread-bg-1', 'thread:thread-bg-2']),
      );

      const callbacks: SocketCallbacks = { onMessage: vi.fn(), onIntentMode: vi.fn() };
      act(() => {
        root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
      });

      // Initial connect — should NOT trigger catch-up
      act(() => {
        const listeners = mockSocket.listeners('connect');
        for (const listener of listeners) {
          (listener as () => void)();
        }
      });
      mockRequestStreamCatchUp.mockClear();

      // Reconnect — active thread always covered; bg threads (thread-bg-1,
      // thread-bg-2) MUST also get a catch-up call because they may have
      // missed broadcasts during the disconnect window. Active thread should
      // appear exactly once even though `thread:thread-1` is also in
      // joinedRoomsRef (dedup via the `bumped` Set).
      act(() => {
        const listeners = mockSocket.listeners('connect');
        for (const listener of listeners) {
          (listener as () => void)();
        }
      });

      const calledThreads = mockRequestStreamCatchUp.mock.calls.map((c) => c[0]);
      // 砚砚 R1 P1: bg coverage must be locked — without these assertions the
      // background loop could be silently deleted and the test would still pass.
      expect(calledThreads).toContain('thread-1');
      expect(calledThreads).toContain('thread-bg-1');
      expect(calledThreads).toContain('thread-bg-2');
      // Active thread dedup: appears exactly once even when `thread:thread-1`
      // is also enumerated from joinedRoomsRef (the `bumped` Set in src skips it)
      const activeCount = calledThreads.filter((t) => t === 'thread-1').length;
      expect(activeCount).toBe(1);
      // Total: 3 distinct threads = 3 calls
      expect(calledThreads).toHaveLength(3);
    });
  });
});
