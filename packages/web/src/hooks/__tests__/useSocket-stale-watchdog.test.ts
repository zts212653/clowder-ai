/**
 * Regression: stale-invocation watchdog unsticks the UI when a done(isFinal)
 * event is dropped on a still-connected socket.
 *
 * Reconnect reconciliation only fires when the socket reconnects; if the socket
 * stays alive but an event is lost (network hiccup, server glitch), the UI
 * shows cats as "replying" forever. The watchdog periodically probes /queue
 * for threads with hasActiveInvocation=true but lastActivity older than 3 min,
 * and clears stale slots when server says they're done.
 */
import EventEmitter from 'node:events';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const mockClearThreadActiveInvocation = vi.fn();
const mockSetLoading = vi.fn();
const mockSetIntentMode = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetStreaming = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockSetThreadLoading = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({
  messages: [] as Array<{ id: string; type: string; isStreaming?: boolean }>,
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
  messages: [] as Array<{
    id: string;
    type: string;
    isStreaming?: boolean;
    deliveredAt?: number;
    timestamp?: number;
  }>,
  activeInvocations: {} as Record<string, { catId: string; mode: string; startedAt: number }>,
  threadStates: {} as Record<string, { hasActiveInvocation: boolean; lastActivity: number; messages?: unknown[] }>,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  setLoading: mockSetLoading,
  setIntentMode: mockSetIntentMode,
  clearCatStatuses: mockClearCatStatuses,
  setStreaming: mockSetStreaming,
  requestStreamCatchUp: mockRequestStreamCatchUp,
  setThreadLoading: mockSetThreadLoading,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  addMessageToThread: vi.fn(),
  appendToThreadMessage: vi.fn(),
  appendToolEventToThread: vi.fn(),
  setThreadCatInvocation: vi.fn(),
  setThreadMessageMetadata: vi.fn(),
  setThreadMessageUsage: vi.fn(),
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
  clearAllActiveInvocations: vi.fn(),
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
    { getState },
  );
  return { useChatStore };
});

vi.mock('@/stores/toastStore', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'test-user',
}));

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3100',
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('../useGameReconnect', () => ({
  reconnectGame: vi.fn(() => Promise.resolve()),
}));

import { configureDebug } from '@/debug/invocationEventDebug';
import { type SocketCallbacks, useSocket } from '../useSocket';

function HookWrapper({ callbacks, threadId }: { callbacks: SocketCallbacks; threadId: string }) {
  useSocket(callbacks, threadId);
  return null;
}

describe('useSocket stale-invocation watchdog', () => {
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
    mockStoreState.hasActiveInvocation = true;
    mockStoreState.messages = [];
    mockStoreState.activeInvocations = {};
    mockStoreState.threadStates = {};
    mockStoreState.currentThreadId = 'thread-1';
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('probes /queue and clears stale slots when active thread has been streaming ≥3 minutes', async () => {
    // Server says no active invocations — cats finished, done event was dropped.
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ activeInvocations: [] }),
    });

    // Active thread's truth lives in flat state: hasActiveInvocation=true with an
    // invocation that started 4 minutes ago.
    const now = Date.now();
    mockStoreState.hasActiveInvocation = true;
    mockStoreState.activeInvocations = {
      'inv-1': { catId: 'opus-47', mode: 'execute', startedAt: now - 4 * 60_000 },
    };

    act(() => {
      root.render(
        React.createElement(HookWrapper, {
          callbacks: { onMessage: vi.fn() },
          threadId: 'thread-1',
        }),
      );
    });

    // Advance past the 30s watchdog interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue');
    expect(mockClearThreadActiveInvocation).toHaveBeenCalledWith('thread-1');
    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
  });

  it('does NOT probe background thread when its lastActivity is recent', async () => {
    const now = Date.now();
    // Active thread is idle with no recent engagement, background thread is active
    // but was streaming just 30s ago — under the 3-min staleness bar.
    mockStoreState.currentThreadId = 'thread-current';
    mockStoreState.hasActiveInvocation = false;
    mockStoreState.messages = [];
    mockStoreState.threadStates = {
      'thread-bg': { hasActiveInvocation: true, lastActivity: now - 30_000, messages: [] },
    };

    act(() => {
      root.render(
        React.createElement(HookWrapper, {
          callbacks: { onMessage: vi.fn() },
          threadId: 'thread-current',
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('does NOT probe active thread when idle and user has not engaged recently', async () => {
    const now = Date.now();
    // Active thread has no invocation locally and last message is 10 min old —
    // user is not waiting, so direction-2 stays quiet.
    mockStoreState.hasActiveInvocation = false;
    mockStoreState.activeInvocations = {};
    mockStoreState.messages = [{ id: 'm1', type: 'user', timestamp: now - 10 * 60_000 }];

    act(() => {
      root.render(
        React.createElement(HookWrapper, {
          callbacks: { onMessage: vi.fn() },
          threadId: 'thread-1',
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('direction 2: hydrates current thread when server has a slot the UI missed', async () => {
    const now = Date.now();
    const slotStartedAt = now - 5_000;
    // Server reports an active slot that the UI never learned about (intent_mode dropped).
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          activeInvocations: [{ catId: 'opus-47', startedAt: slotStartedAt }],
        }),
    });

    // UI shows idle locally (flat state), but the user sent a message 30s ago —
    // engagement signal comes from the last message timestamp.
    mockStoreState.currentThreadId = 'thread-1';
    mockStoreState.hasActiveInvocation = false;
    mockStoreState.activeInvocations = {};
    mockStoreState.messages = [{ id: 'm1', type: 'user', timestamp: now - 30_000, deliveredAt: now - 30_000 }];

    act(() => {
      root.render(
        React.createElement(HookWrapper, {
          callbacks: { onMessage: vi.fn() },
          threadId: 'thread-1',
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue');
    expect(mockStoreState.updateThreadCatStatus).toHaveBeenCalledWith('thread-1', 'opus-47', 'streaming');
    expect(mockStoreState.addActiveInvocation).toHaveBeenCalledWith(
      'hydrated-thread-1-opus-47',
      'opus-47',
      'execute',
      slotStartedAt,
    );
  });

  it('direction 2: does NOT probe after normal completion (last msg is recent assistant reply)', async () => {
    const now = Date.now();
    mockStoreState.currentThreadId = 'thread-1';
    mockStoreState.hasActiveInvocation = false;
    mockStoreState.activeInvocations = {};
    // Normal round-trip finished: last message is a recent assistant reply (non-streaming).
    // Without the user-wait gate, watchdog would probe /queue every cooldown window
    // for 5 minutes on a perfectly healthy thread (codex P2 on useSocket.ts:294).
    mockStoreState.messages = [
      { id: 'u1', type: 'user', timestamp: now - 10_000, deliveredAt: now - 10_000 },
      { id: 'a1', type: 'assistant', timestamp: now - 2_000, deliveredAt: now - 2_000 },
    ];

    act(() => {
      root.render(
        React.createElement(HookWrapper, {
          callbacks: { onMessage: vi.fn() },
          threadId: 'thread-1',
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('direction 2: does NOT probe current thread when user has not engaged recently', async () => {
    const now = Date.now();
    mockStoreState.currentThreadId = 'thread-1';
    mockStoreState.hasActiveInvocation = false;
    mockStoreState.activeInvocations = {};
    // Last message older than STALE_RECENT_ENGAGEMENT_MS (5 min) — user not actively waiting.
    mockStoreState.messages = [{ id: 'm1', type: 'user', timestamp: now - 6 * 60_000, deliveredAt: now - 6 * 60_000 }];

    act(() => {
      root.render(
        React.createElement(HookWrapper, {
          callbacks: { onMessage: vi.fn() },
          threadId: 'thread-1',
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('respects cooldown: does not re-probe the same thread on subsequent watchdog ticks', async () => {
    // Server says no active invocations on first probe.
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ activeInvocations: [] }),
    });

    const now = Date.now();
    mockStoreState.hasActiveInvocation = true;
    mockStoreState.activeInvocations = {
      'inv-1': { catId: 'opus-47', mode: 'execute', startedAt: now - 5 * 60_000 },
    };

    act(() => {
      root.render(
        React.createElement(HookWrapper, {
          callbacks: { onMessage: vi.fn() },
          threadId: 'thread-1',
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    // Second watchdog tick 30s later — cooldown (60s) should block re-probe.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    // After another 30s (total 60s+ since first probe), cooldown expires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });
});
