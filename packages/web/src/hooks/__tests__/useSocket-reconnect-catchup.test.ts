/**
 * Regression test for reconnect catch-up (#276 intake).
 *
 * When the server finishes processing during a socket disconnect,
 * done(isFinal) is lost. After reconnect, reconciliation detects
 * "server done but local had active invocations" and should trigger
 * requestStreamCatchUp so the user sees the response without F5.
 */
import EventEmitter from 'node:events';
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
  setStreaming: mockSetStreaming,
  requestStreamCatchUp: mockRequestStreamCatchUp,
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
  clearThreadActiveInvocation: vi.fn(),
  replaceThreadTargetCats: vi.fn(),
  addActiveInvocation: vi.fn(),
  addThreadActiveInvocation: vi.fn(),
};

vi.mock('@/stores/chatStore', () => {
  const store = {
    getState: () => mockStoreState,
  };
  return { useChatStore: store };
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
      vi.advanceTimersByTime(2500);
      // Let async apiFetch resolve
      await vi.runAllTimersAsync();
    });

    // Server had no active invocations → stale state cleared → catch-up triggered
    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
  });

  it('does NOT trigger catch-up when server still has active invocations', async () => {
    // Server says still processing
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ activeInvocations: ['opus'] }),
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
      vi.advanceTimersByTime(2500);
      await vi.runAllTimersAsync();
    });

    // Server still active → re-hydrate, don't catch-up
    expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();
  });

  it('does NOT trigger eager catch-up on reconnect before reconciliation (#266)', async () => {
    // Simulate isLoading=true (invocation was in progress before disconnect)
    (mockStoreState as Record<string, unknown>).isLoading = true;

    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onIntentMode: vi.fn(),
    };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
    });

    // Simulate reconnect
    act(() => {
      const listeners = mockSocket.listeners('connect');
      for (const listener of listeners) {
        (listener as () => void)();
      }
    });

    // BEFORE reconciliation delay: catch-up must NOT have fired.
    // The old code (pre-fix) would eagerly call requestStreamCatchUp here,
    // causing store/ref desync when stream was still active.
    expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();

    // Advance past reconciliation delay — now server confirms done
    await act(async () => {
      vi.advanceTimersByTime(2500);
      await vi.runAllTimersAsync();
    });

    // Only NOW should catch-up fire (via reconciliation, not eager path)
    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');

    // Cleanup
    delete (mockStoreState as Record<string, unknown>).isLoading;
  });

  it('takes no action when /queue returns non-ok (#266)', async () => {
    (mockStoreState as Record<string, unknown>).isLoading = true;

    // /queue returns 500 — unknown server state
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 500,
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
      vi.advanceTimersByTime(2500);
      await vi.runAllTimersAsync();
    });

    // /queue failed → unknown state → safe inaction (no state clearing, no catch-up)
    expect(mockClearAllActiveInvocations).not.toHaveBeenCalled();
    expect(mockSetLoading).not.toHaveBeenCalled();
    expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();

    delete (mockStoreState as Record<string, unknown>).isLoading;
  });

  it('stale reconnect error does NOT trigger catch-up after newer reconnect starts (#266)', async () => {
    (mockStoreState as Record<string, unknown>).isLoading = true;

    // Generation-1: /queue will reject slowly (network error after delay)
    let rejectGen1!: (err: Error) => void;
    const gen1Promise = new Promise<never>((_resolve, reject) => {
      rejectGen1 = reject;
    });
    mockApiFetch.mockReturnValueOnce(gen1Promise);

    // Generation-2: /queue returns active invocations (server still processing)
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ activeInvocations: ['opus'] }),
    });

    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onIntentMode: vi.fn(),
    };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-1' }));
    });

    // Reconnect #1
    act(() => {
      const listeners = mockSocket.listeners('connect');
      for (const listener of listeners) {
        (listener as () => void)();
      }
    });

    // Advance past reconciliation delay for generation-1
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });

    // Reconnect #2 (bumps generation, supersedes #1)
    act(() => {
      const listeners = mockSocket.listeners('connect');
      for (const listener of listeners) {
        (listener as () => void)();
      }
    });

    // Advance past reconciliation delay for generation-2
    await act(async () => {
      vi.advanceTimersByTime(2500);
      await vi.runAllTimersAsync();
    });

    // Now reject generation-1's /queue — should NOT trigger catch-up
    await act(async () => {
      rejectGen1(new Error('Network error from stale reconnect'));
      await vi.runAllTimersAsync();
    });

    // Generation-2 saw active invocations → no catch-up.
    // Generation-1's stale error → guarded, no catch-up.
    expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();

    delete (mockStoreState as Record<string, unknown>).isLoading;
  });

  it('takes no action when /queue throws network error (#266)', async () => {
    (mockStoreState as Record<string, unknown>).isLoading = true;

    // /queue throws — unknown server state
    mockApiFetch.mockRejectedValue(new Error('Network error'));

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
      vi.advanceTimersByTime(2500);
      await vi.runAllTimersAsync();
    });

    // Network error → unknown state → safe inaction (no state clearing, no catch-up)
    expect(mockClearAllActiveInvocations).not.toHaveBeenCalled();
    expect(mockSetLoading).not.toHaveBeenCalled();
    expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();

    delete (mockStoreState as Record<string, unknown>).isLoading;
  });
});
