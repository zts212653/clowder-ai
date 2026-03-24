/**
 * P1 regression test for cross-thread event leakage via useSocket.
 *
 * Tests the actual useSocket hook with a mock socket.io EventEmitter,
 * verifying that intent_mode and agent_message events from a non-active
 * thread are NOT forwarded to callbacks (preventing the "duplicate cat" bug).
 *
 * Red→Green: Before the fix, intent_mode had no threadIdRef guard in useSocket,
 * so events from thread A would leak into thread B's callback after a switch.
 */

import EventEmitter from 'node:events';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock socket.io-client ──
// Create a controllable EventEmitter that acts as a socket.io client.
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
// Override emit to no-op (prevent join_room etc. from triggering listeners during tests)
mockSocket.emit = vi.fn(() => true) as unknown as typeof mockSocket.emit;
mockSocket.disconnect = vi.fn();

vi.mock('socket.io-client', () => ({
  io: () => mockSocket,
}));

// ── Mock stores ──
const mockAddMessageToThread = vi.fn();
const mockAppendToThreadMessage = vi.fn();
const mockAppendToolEventToThread = vi.fn();
const mockSetThreadCatInvocation = vi.fn();
const mockSetThreadMessageMetadata = vi.fn();
const mockSetThreadMessageUsage = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockSetThreadLoading = vi.fn();
const mockSetThreadHasActiveInvocation = vi.fn();
const mockSetQueue = vi.fn();
const mockSetQueuePaused = vi.fn();
const mockSetQueueFull = vi.fn();
const mockSetThreadIntentMode = vi.fn();
const mockSetThreadTargetCats = vi.fn();
const mockUpdateThreadCatStatus = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockGetThreadState = vi.fn(() => ({
  messages: [],
  isLoading: false,
  isLoadingHistory: false,
  hasMore: true,
  hasActiveInvocation: false,
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  currentGame: null,

  unreadCount: 0,
  lastActivity: 0,
}));
let mockStoreCurrentThreadId = 'thread-B';

vi.mock('@/stores/chatStore', () => {
  const store = {
    getState: () => ({
      currentThreadId: mockStoreCurrentThreadId,
      addMessageToThread: mockAddMessageToThread,
      appendToThreadMessage: mockAppendToThreadMessage,
      appendToolEventToThread: mockAppendToolEventToThread,
      setThreadCatInvocation: mockSetThreadCatInvocation,
      setThreadMessageMetadata: mockSetThreadMessageMetadata,
      setThreadMessageUsage: mockSetThreadMessageUsage,
      setThreadMessageStreaming: mockSetThreadMessageStreaming,
      setThreadLoading: mockSetThreadLoading,
      setThreadHasActiveInvocation: mockSetThreadHasActiveInvocation,
      setQueue: mockSetQueue,
      setQueuePaused: mockSetQueuePaused,
      setQueueFull: mockSetQueueFull,
      setThreadIntentMode: mockSetThreadIntentMode,
      setThreadTargetCats: mockSetThreadTargetCats,
      updateThreadCatStatus: mockUpdateThreadCatStatus,
      clearThreadActiveInvocation: mockClearThreadActiveInvocation,
      getThreadState: mockGetThreadState,
    }),
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

let mockUserId = 'test-user';
vi.mock('@/utils/userId', () => ({
  getUserId: () => mockUserId,
}));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3100',
}));

import { configureDebug, invocationDebugConstants } from '@/debug/invocationEventDebug';
// ── Import useSocket after mocks ──
import { type SocketCallbacks, useSocket } from '../useSocket';

/**
 * Minimal wrapper component to mount the useSocket hook with controlled threadId.
 */
function HookWrapper({ callbacks, threadId }: { callbacks: SocketCallbacks; threadId: string }) {
  useSocket(callbacks, threadId);
  return null;
}

/**
 * Simulate a server-side socket event arriving at the client.
 * Uses the original EventEmitter.emit (not the mocked socket.emit).
 */
function simulateServerEvent(event: string, data: unknown) {
  // Get all listeners registered on the mock socket and call them
  const listeners = mockSocket.listeners(event);
  for (const listener of listeners) {
    (listener as (data: unknown) => void)(data);
  }
}

type WindowDebugApi = {
  dump: (options?: { rawThreadId?: boolean }) => string;
};

describe('useSocket thread guard (P1 regression: cross-thread event leakage)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.sessionStorage.clear();
    window.sessionStorage.removeItem(invocationDebugConstants.STORAGE_KEY);
    configureDebug({ enabled: false });
    delete (window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug;
    mockUserId = 'test-user';
    mockStoreCurrentThreadId = 'thread-B';
    mockAddMessageToThread.mockClear();
    mockAppendToThreadMessage.mockClear();
    mockAppendToolEventToThread.mockClear();
    mockSetThreadCatInvocation.mockClear();
    mockSetThreadMessageMetadata.mockClear();
    mockSetThreadMessageUsage.mockClear();
    mockSetThreadMessageStreaming.mockClear();
    mockSetThreadLoading.mockClear();
    mockSetThreadHasActiveInvocation.mockClear();
    mockSetQueue.mockClear();
    mockSetQueuePaused.mockClear();
    mockSetQueueFull.mockClear();
    mockSetThreadIntentMode.mockClear();
    mockSetThreadTargetCats.mockClear();
    mockUpdateThreadCatStatus.mockClear();
    mockClearThreadActiveInvocation.mockClear();
    mockGetThreadState.mockClear();
    // Clear all socket listeners from previous tests
    mockSocket.removeAllListeners();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    window.sessionStorage.removeItem(invocationDebugConstants.STORAGE_KEY);
    configureDebug({ enabled: false });
    delete (window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug;
  });

  it('intent_mode from active thread is forwarded to callback', () => {
    // Dual-pointer guard: both route and store must agree
    mockStoreCurrentThreadId = 'thread-A';
    const onIntentMode = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onIntentMode,
    };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-A' }));
    });

    act(() => {
      simulateServerEvent('intent_mode', {
        threadId: 'thread-A',
        mode: 'execute',
        targetCats: ['opus'],
      });
    });

    expect(onIntentMode).toHaveBeenCalledTimes(1);
    expect(onIntentMode).toHaveBeenCalledWith({
      threadId: 'thread-A',
      mode: 'execute',
      targetCats: ['opus'],
    });
  });

  it('intent_mode from OTHER thread routes to background path, not callback', () => {
    const onIntentMode = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onIntentMode,
    };

    // Mount with thread-B as active
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    // Simulate intent_mode arriving for thread-A (cross-thread event)
    act(() => {
      simulateServerEvent('intent_mode', {
        threadId: 'thread-A',
        mode: 'execute',
        targetCats: ['opus'],
      });
    });

    // MUST NOT be forwarded to callback — this is the core regression guard
    expect(onIntentMode).not.toHaveBeenCalled();

    // Background path: thread-scoped state is updated for the non-active thread
    expect(mockSetThreadLoading).toHaveBeenCalledWith('thread-A', true);
    expect(mockSetThreadHasActiveInvocation).toHaveBeenCalledWith('thread-A', true);
    expect(mockSetThreadIntentMode).toHaveBeenCalledWith('thread-A', 'execute');
    expect(mockSetThreadTargetCats).toHaveBeenCalledWith('thread-A', ['opus']);
  });

  it('intent_mode for switched-away thread routes to background after thread change', () => {
    const onIntentMode = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onIntentMode,
    };

    // Start on thread-A (both route and store agree)
    mockStoreCurrentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-A' }));
    });

    // Switch to thread-B (simulates user clicking another thread — store follows route)
    mockStoreCurrentThreadId = 'thread-B';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    // Now thread-A's late intent_mode arrives — must NOT forward to callback
    act(() => {
      simulateServerEvent('intent_mode', {
        threadId: 'thread-A',
        mode: 'execute',
        targetCats: ['opus'],
      });
    });

    expect(onIntentMode).not.toHaveBeenCalled();
    // But thread-A's state is updated via background path
    expect(mockSetThreadIntentMode).toHaveBeenCalledWith('thread-A', 'execute');

    // thread-B's intent_mode should still forward to callback
    act(() => {
      simulateServerEvent('intent_mode', {
        threadId: 'thread-B',
        mode: 'ideate',
        targetCats: ['codex'],
      });
    });

    expect(onIntentMode).toHaveBeenCalledTimes(1);
    expect(onIntentMode).toHaveBeenCalledWith({
      threadId: 'thread-B',
      mode: 'ideate',
      targetCats: ['codex'],
    });
  });

  it('agent_message from other thread goes to background handler, not onMessage', () => {
    const onMessage = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage,
    };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    // agent_message from thread-A (background)
    act(() => {
      simulateServerEvent('agent_message', {
        type: 'text',
        catId: 'opus',
        threadId: 'thread-A',
        content: 'hello from thread A',
        timestamp: Date.now(),
      });
    });

    // onMessage should NOT be called for background thread events
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('route/store mismatch: message for route thread must go background until store switches', () => {
    const onMessage = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage,
    };

    // Route has switched to thread-B, but store still points to old thread-A.
    mockStoreCurrentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    // Message belongs to the new route thread (thread-B).
    act(() => {
      simulateServerEvent('agent_message', {
        type: 'text',
        catId: 'opus',
        threadId: 'thread-B',
        content: 'from thread B during switch window',
        timestamp: Date.now(),
      });
    });

    // Must not mutate old active flat state via onMessage.
    expect(onMessage).not.toHaveBeenCalled();
    // Must be routed as background so it lands in thread-B state map.
    expect(mockAddMessageToThread).toHaveBeenCalledTimes(1);
    expect(mockAddMessageToThread.mock.calls[0]?.[0]).toBe('thread-B');
  });

  it('route/store mismatch: non-text tool_use event is preserved via background path', () => {
    const onMessage = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage,
    };

    mockStoreCurrentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    act(() => {
      simulateServerEvent('agent_message', {
        type: 'tool_use',
        catId: 'opus',
        threadId: 'thread-B',
        toolName: 'TodoWrite',
        toolInput: { tasks: ['A', 'B'] },
        timestamp: Date.now(),
      });
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(mockAddMessageToThread).toHaveBeenCalledTimes(1);
    expect(mockAddMessageToThread.mock.calls[0]?.[0]).toBe('thread-B');
    expect(mockAddMessageToThread.mock.calls[0]?.[1]).toMatchObject({ type: 'assistant', catId: 'opus' });
    expect(mockAppendToolEventToThread).toHaveBeenCalledTimes(1);
    expect(mockAppendToolEventToThread.mock.calls[0]?.[0]).toBe('thread-B');
  });

  it('queue_updated processing marks thread as active invocation (P1 regression)', () => {
    mockStoreCurrentThreadId = 'thread-B';
    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    act(() => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [
          {
            id: 'q1',
            status: 'processing',
          },
        ],
        action: 'processing',
      });
    });

    expect(mockSetQueue).toHaveBeenCalledWith('thread-B', expect.any(Array));
    expect(mockSetThreadHasActiveInvocation).toHaveBeenCalledWith('thread-B', true);
  });

  it('debug API stays unmounted by default (P0: default disabled)', () => {
    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    expect((window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug).toBeUndefined();
  });

  it('debug disabled: queue_updated does not read thread snapshot metadata', () => {
    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    act(() => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [{ id: 'q1', status: 'processing' }],
        action: 'processing',
      });
    });

    expect(mockGetThreadState).not.toHaveBeenCalled();
  });

  it('debug disabled: queue_paused with malformed queue payload does not throw', () => {
    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    expect(() => {
      act(() => {
        simulateServerEvent('queue_paused', {
          threadId: 'thread-B',
          reason: 'failed',
          queue: [null],
        });
      });
    }).not.toThrow();

    expect(mockSetQueue).toHaveBeenCalledWith('thread-B', [null]);
    expect(mockSetQueuePaused).toHaveBeenCalledWith('thread-B', true, 'failed');
  });

  it('debug enabled: non-array queue payload does not crash debug mapping', () => {
    window.sessionStorage.setItem(invocationDebugConstants.STORAGE_KEY, '1');
    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    const debugApi = (window as typeof window & { __catCafeDebug?: WindowDebugApi }).__catCafeDebug;
    expect(debugApi).toBeDefined();

    expect(() => {
      act(() => {
        simulateServerEvent('queue_updated', {
          threadId: 'thread-B',
          queue: {} as unknown as unknown[],
          action: 'processing',
        });
      });
    }).not.toThrow();

    const dump = JSON.parse(debugApi!.dump({ rawThreadId: true })) as {
      events: Array<Record<string, unknown>>;
    };
    const event = dump.events.find((item) => item.event === 'queue_updated');
    expect(event?.queueLength).toBe(0);
    expect(event?.queueStatuses).toEqual([]);
  });

  it('debug dump masks threadId by default and strips blocked fields', () => {
    window.sessionStorage.setItem(invocationDebugConstants.STORAGE_KEY, '1');
    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    const debugApi = (window as typeof window & { __catCafeDebug?: WindowDebugApi }).__catCafeDebug;
    expect(debugApi).toBeDefined();

    act(() => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [{ id: 'q1', status: 'processing', content: 'hidden' }],
        action: 'processing',
      });
    });

    const maskedDump = JSON.parse(debugApi!.dump()) as {
      meta: { marker: string; rawThreadId: boolean };
      events: Array<Record<string, unknown>>;
    };
    expect(maskedDump.meta.marker).toBe('MASKED');
    expect(maskedDump.meta.rawThreadId).toBe(false);
    const maskedEvent = maskedDump.events.find((event) => event.event === 'queue_updated');
    expect(maskedEvent?.threadId).not.toBe('thread-B');
    expect(maskedEvent?.content).toBeUndefined();
    expect(maskedEvent?.token).toBeUndefined();
    expect(maskedEvent?.headers).toBeUndefined();
    expect(maskedEvent?.userInput).toBeUndefined();

    const rawDump = JSON.parse(debugApi!.dump({ rawThreadId: true })) as {
      meta: { marker: string; rawThreadId: boolean };
      events: Array<Record<string, unknown>>;
    };
    expect(rawDump.meta.marker).toBe('RAW');
    expect(rawDump.meta.rawThreadId).toBe(true);
    const rawEvent = rawDump.events.find((event) => event.event === 'queue_updated');
    expect(rawEvent?.threadId).toBe('thread-B');
    expect(rawEvent?.hasActiveInvocation).toBe(true);
    expect(rawEvent?.queuePaused).toBe(false);
  });

  it('socket is NOT disconnected/reconnected when callbacks change (callbacksRef pattern)', () => {
    const callbacks1: SocketCallbacks = { onMessage: vi.fn() };
    const callbacks2: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks: callbacks1, threadId: 'thread-A' }));
    });

    const disconnectCallCount = (mockSocket.disconnect as ReturnType<typeof vi.fn>).mock.calls.length;

    // Re-render with different callbacks (simulates socketCallbacks useMemo rebuild)
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks: callbacks2, threadId: 'thread-A' }));
    });

    // Socket should NOT have been disconnected
    expect((mockSocket.disconnect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(disconnectCallCount);
  });

  it('updated callbacks are used after re-render (ref stays fresh)', () => {
    mockStoreCurrentThreadId = 'thread-A';
    const onIntentMode1 = vi.fn();
    const onIntentMode2 = vi.fn();

    act(() => {
      root.render(
        React.createElement(HookWrapper, {
          callbacks: { onMessage: vi.fn(), onIntentMode: onIntentMode1 },
          threadId: 'thread-A',
        }),
      );
    });

    // Update callbacks (simulates thread switch causing useMemo rebuild)
    act(() => {
      root.render(
        React.createElement(HookWrapper, {
          callbacks: { onMessage: vi.fn(), onIntentMode: onIntentMode2 },
          threadId: 'thread-A',
        }),
      );
    });

    // Fire intent_mode — should use the LATEST callback (onIntentMode2)
    act(() => {
      simulateServerEvent('intent_mode', {
        threadId: 'thread-A',
        mode: 'execute',
        targetCats: ['opus'],
      });
    });

    expect(onIntentMode1).not.toHaveBeenCalled();
    expect(onIntentMode2).toHaveBeenCalledTimes(1);
  });

  it('rejoins persisted thread rooms on connect after refresh', () => {
    window.sessionStorage.setItem(
      'cat-cafe:ws:joined-rooms:v1:test-user',
      JSON.stringify(['thread:thread-A', 'thread:thread-B']),
    );

    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    const emitMock = mockSocket.emit as unknown as ReturnType<typeof vi.fn>;
    emitMock.mockClear();

    act(() => {
      simulateServerEvent('connect', undefined);
    });

    const joinedRooms = emitMock.mock.calls.filter(([event]) => event === 'join_room').map(([, room]) => room);

    expect(new Set(joinedRooms)).toEqual(new Set(['thread:thread-A', 'thread:thread-B']));
  });

  it('thread_summary from OTHER thread is silently dropped (cross-thread leakage guard)', () => {
    const onThreadSummary = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onThreadSummary,
    };

    // Active thread is thread-B (both route and store agree)
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    // Summary arrives from thread-A (background auto-summary)
    act(() => {
      simulateServerEvent('thread_summary', {
        id: 'sum-1',
        threadId: 'thread-A',
        topic: 'Discussion about cats',
        conclusions: ['cats are great'],
        openQuestions: [],
        createdBy: 'system',
        createdAt: Date.now(),
      });
    });

    // MUST NOT be forwarded — this is the P1 regression guard
    expect(onThreadSummary).not.toHaveBeenCalled();
  });

  it('thread_summary from ACTIVE thread is forwarded to callback', () => {
    mockStoreCurrentThreadId = 'thread-A';
    const onThreadSummary = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onThreadSummary,
    };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-A' }));
    });

    act(() => {
      simulateServerEvent('thread_summary', {
        id: 'sum-2',
        threadId: 'thread-A',
        topic: 'Summary for active thread',
        conclusions: ['all good'],
        openQuestions: [],
        createdBy: 'system',
        createdAt: Date.now(),
      });
    });

    expect(onThreadSummary).toHaveBeenCalledTimes(1);
    expect(onThreadSummary).toHaveBeenCalledWith(expect.objectContaining({ id: 'sum-2', threadId: 'thread-A' }));
  });

  it('thread_summary during route/store mismatch is NOT forwarded (dual-pointer guard)', () => {
    // Route has switched to thread-B, but store still points to thread-A.
    // This is the switch-window race that the dual-pointer guard must catch.
    mockStoreCurrentThreadId = 'thread-A';
    const onThreadSummary = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onThreadSummary,
    };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    // Summary for thread-B arrives — route matches but store doesn't
    act(() => {
      simulateServerEvent('thread_summary', {
        id: 'sum-mismatch',
        threadId: 'thread-B',
        topic: 'Summary during switch window',
        conclusions: [],
        openQuestions: [],
        createdBy: 'system',
        createdAt: Date.now(),
      });
    });

    // Must NOT forward — would write into thread-A's flat state
    expect(onThreadSummary).not.toHaveBeenCalled();
  });

  it('does not restore rooms persisted by another user id', () => {
    window.sessionStorage.setItem('cat-cafe:ws:joined-rooms:v1:alice', JSON.stringify(['thread:alice-secret']));
    window.sessionStorage.setItem('cat-cafe:ws:joined-rooms:v1:bob', JSON.stringify(['thread:bob-work']));
    mockUserId = 'bob';

    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    const emitMock = mockSocket.emit as unknown as ReturnType<typeof vi.fn>;
    emitMock.mockClear();

    act(() => {
      simulateServerEvent('connect', undefined);
    });

    const joinedRooms = emitMock.mock.calls.filter(([event]) => event === 'join_room').map(([, room]) => room);

    expect(new Set(joinedRooms)).toEqual(new Set(['thread:bob-work', 'thread:thread-B']));
  });

  it('connector_message from active thread is appended immediately (no F5 needed)', () => {
    mockStoreCurrentThreadId = 'thread-B';
    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    act(() => {
      simulateServerEvent('connector_message', {
        threadId: 'thread-B',
        message: {
          id: 'conn-1',
          type: 'connector',
          content: '**GitHub Review 通知**',
          source: { connector: 'github-review', label: 'GitHub Review', icon: '🔔' },
          timestamp: Date.now(),
        },
      });
    });

    expect(mockAddMessageToThread).toHaveBeenCalledTimes(1);
    expect(mockAddMessageToThread).toHaveBeenCalledWith(
      'thread-B',
      expect.objectContaining({ id: 'conn-1', type: 'connector' }),
    );
  });

  it('connector_message from background thread is added to that thread state', () => {
    mockStoreCurrentThreadId = 'thread-B';
    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    act(() => {
      simulateServerEvent('connector_message', {
        threadId: 'thread-A',
        message: {
          id: 'conn-bg-1',
          type: 'connector',
          content: '**GitHub Review 通知**',
          source: { connector: 'github-review', label: 'GitHub Review', icon: '🔔' },
          timestamp: Date.now(),
        },
      });
    });

    expect(mockAddMessageToThread).toHaveBeenCalledTimes(1);
    expect(mockAddMessageToThread).toHaveBeenCalledWith(
      'thread-A',
      expect.objectContaining({ id: 'conn-bg-1', type: 'connector' }),
    );
  });
});
