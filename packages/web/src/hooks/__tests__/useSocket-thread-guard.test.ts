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

import EventEmitter from 'events';
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
const mockSetQueue = vi.fn((threadId: string, queue: unknown[]) => {
  mockThreadQueues.set(threadId, queue);
});
const mockSetQueuePaused = vi.fn();
const mockSetQueueFull = vi.fn();
const mockSetThreadIntentMode = vi.fn();
const mockSetThreadTargetCats = vi.fn();
const mockReplaceThreadTargetCats = vi.fn();
const mockUpdateThreadCatStatus = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockAddActiveInvocation = vi.fn();
const mockSetCatStatus = vi.fn();
const mockRemoveActiveInvocation = vi.fn();
const mockAddToast = vi.fn();
const mockThreadQueues = new Map<string, unknown[]>();
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
  const getState = () => ({
    currentThreadId: mockStoreCurrentThreadId,
    queue: mockThreadQueues.get(mockStoreCurrentThreadId) ?? [],
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
    replaceThreadTargetCats: mockReplaceThreadTargetCats,
    updateThreadCatStatus: mockUpdateThreadCatStatus,
    clearThreadActiveInvocation: mockClearThreadActiveInvocation,
    clearThreadCatStatuses: vi.fn(),
    addThreadActiveInvocation: mockAddActiveInvocation,
    addActiveInvocation: vi.fn(),
    removeActiveInvocation: mockRemoveActiveInvocation,
    setCatStatus: mockSetCatStatus,
    activeInvocations: {} as Record<string, { catId: string; mode: string }>,
    getThreadState: mockGetThreadState,
  });
  const useChatStore = ((selector?: (state: ReturnType<typeof getState>) => unknown) =>
    selector ? selector(getState()) : getState()) as {
    (selector?: (state: ReturnType<typeof getState>) => unknown): unknown;
    getState: typeof getState;
  };
  useChatStore.getState = getState;
  return { useChatStore };
});

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({
      addToast: mockAddToast,
    }),
  },
}));

let mockUserId = 'test-user';
const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/userId', () => ({
  getUserId: () => mockUserId,
}));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3100',
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { configureDebug, invocationDebugConstants } from '@/debug/invocationEventDebug';
// ── Import useSocket after mocks ──
import { type OrchestrationFlow, useGuideStore } from '@/stores/guideStore';
import { type SocketCallbacks, useSocket } from '../useSocket';

const GUIDE_FLOW: OrchestrationFlow = {
  id: 'add-member',
  name: 'Add Member',
  steps: [{ id: 'step-1', target: 'cats.add-member', tips: 'Add member', advance: 'click' }],
};

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
    mockThreadQueues.clear();
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
    mockReplaceThreadTargetCats.mockClear();
    mockUpdateThreadCatStatus.mockClear();
    mockClearThreadActiveInvocation.mockClear();
    mockAddActiveInvocation.mockClear();
    mockAddToast.mockClear();
    mockGetThreadState.mockClear();
    mockApiFetch.mockReset();
    useGuideStore.setState({ session: null, completionPersisted: false, completionFailed: false, pendingStart: null });
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
    useGuideStore.setState({ session: null, completionPersisted: false, completionFailed: false, pendingStart: null });
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

  it('guide_complete from active thread is reduced into guide store state', () => {
    mockStoreCurrentThreadId = 'thread-A';
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
    };
    useGuideStore.setState({
      session: {
        flow: GUIDE_FLOW,
        sessionId: 'guide-add-member-1',
        threadId: 'thread-A',
        currentStepIndex: 0,
        phase: 'active',
        startedAt: Date.now(),
      },
    });

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-A' }));
    });

    act(() => {
      simulateServerEvent('guide_complete', {
        guideId: 'add-member',
        threadId: 'thread-A',
        timestamp: Date.now(),
      });
    });

    expect(useGuideStore.getState().session?.phase).toBe('complete');
  });

  it('replays a dropped guide_start into pendingStart when that thread becomes active again', () => {
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
    };

    mockStoreCurrentThreadId = 'thread-B';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    act(() => {
      simulateServerEvent('guide_start', {
        guideId: 'add-member',
        threadId: 'thread-A',
        timestamp: 123,
      });
    });

    expect(useGuideStore.getState().pendingStart).toBeNull();

    mockStoreCurrentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-A' }));
    });

    expect(useGuideStore.getState().pendingStart).toEqual({
      guideId: 'add-member',
      threadId: 'thread-A',
    });
  });

  it('does not replay a queued guide_start after off-thread exit control clears it', () => {
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
    };

    mockStoreCurrentThreadId = 'thread-B';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    act(() => {
      simulateServerEvent('guide_start', {
        guideId: 'add-member',
        threadId: 'thread-A',
        timestamp: 123,
      });
    });

    expect(useGuideStore.getState().pendingStart).toBeNull();

    act(() => {
      simulateServerEvent('guide_control', {
        action: 'exit',
        guideId: 'add-member',
        threadId: 'thread-A',
        timestamp: 124,
      });
    });

    mockStoreCurrentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-A' }));
    });

    expect(useGuideStore.getState().pendingStart).toBeNull();
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

  it('F173 Phase E (KD-1): agent_message from any thread forwards to onMessage (single dispatch)', () => {
    const onMessage = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage,
    };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    // agent_message from thread-A (would have been "background" pre-Phase E)
    act(() => {
      simulateServerEvent('agent_message', {
        type: 'text',
        catId: 'opus',
        threadId: 'thread-A',
        content: 'hello from thread A',
        timestamp: Date.now(),
      });
    });

    // Phase E: useSocket no longer dispatches active vs background.
    // useAgentMessages.handleAgentMessage 是 single dispatch entry，自己路由。
    // useSocket 的契约只是"转发到 onMessage"——所有 thread 都应该被 forward。
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ threadId: 'thread-A', content: 'hello from thread A' });
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

    // Phase E: useSocket forwards everything to onMessage (single dispatch).
    // useAgentMessages.handleAgentMessage 内部判断 active vs background，并对
    // background path 调用 handleBackgroundAgentMessage（mockAddMessageToThread）。
    // 这里 onMessage 是 vi.fn() 不真跑 useAgentMessages 内部逻辑——只验 forward。
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ threadId: 'thread-B' });
  });

  // F173 Phase A.2 — single-pointer routing (KD-4)
  // Original dual-pointer guard requires BOTH route and store to match msg.threadId,
  // which mis-routes events when route is stale but store is the truth source.
  // Single-pointer routing uses store as the only source of truth for active-thread decision.
  it('F173 reverse race: route stale, store=msg.threadId → must go active (single-pointer routing)', () => {
    const onMessage = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage,
    };

    // Reverse race: store has already switched to thread-B (the truth source), but
    // route ref is still on stale thread-A (URL update lagging behind setCurrentThread).
    mockStoreCurrentThreadId = 'thread-B';
    act(() => {
      // route=A (stale), store=B (truth)
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-A' }));
    });

    // Message belongs to thread-B (matches store truth)
    act(() => {
      simulateServerEvent('agent_message', {
        type: 'text',
        catId: 'opus',
        threadId: 'thread-B',
        content: 'belongs to thread-B per store truth',
        timestamp: Date.now(),
      });
    });

    // Single-pointer (store) routing → onMessage MUST be called (active path)
    // Original dual-pointer would mis-route to background because route ≠ msg.threadId.
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
      threadId: 'thread-B',
      content: 'belongs to thread-B per store truth',
    });
    // Background path must NOT also fire
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });

  it('F173 reverse race intent_mode: route stale, store=data.threadId → must forward to callback', () => {
    const onIntentMode = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onIntentMode,
    };

    mockStoreCurrentThreadId = 'thread-B';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-A' }));
    });

    act(() => {
      simulateServerEvent('intent_mode', {
        threadId: 'thread-B',
        mode: 'execute',
        targetCats: ['opus'],
      });
    });

    expect(onIntentMode).toHaveBeenCalledTimes(1);
    expect(onIntentMode.mock.calls[0]?.[0]).toMatchObject({ threadId: 'thread-B', mode: 'execute' });
  });

  it('F173 reverse race spawn_started: route stale, store=data.threadId → must forward to callback', () => {
    const onSpawnStarted = vi.fn();
    const callbacks: SocketCallbacks = {
      onMessage: vi.fn(),
      onSpawnStarted,
    };

    mockStoreCurrentThreadId = 'thread-B';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-A' }));
    });

    act(() => {
      simulateServerEvent('spawn_started', {
        threadId: 'thread-B',
        targetCats: ['opus'],
        invocationId: 'inv-1',
      });
    });

    expect(onSpawnStarted).toHaveBeenCalledTimes(1);
    expect(onSpawnStarted.mock.calls[0]?.[0]).toMatchObject({ threadId: 'thread-B' });
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

    // Phase E: useSocket forwards all events to onMessage (single dispatch).
    // useAgentMessages 内部判断 active vs background 并调 bg helpers (mockAddMessageToThread,
    // mockAppendToolEventToThread)。这里 onMessage 是 vi.fn() 不真跑——仅验 forward。
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'tool_use', threadId: 'thread-B', catId: 'opus' });
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

  it('queue_updated processing hydrates current-thread slot truth when intent_mode is missing', async () => {
    mockStoreCurrentThreadId = 'thread-B';
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        activeInvocations: [{ catId: 'gpt52', startedAt: 1234 }],
      }),
    });

    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    await act(async () => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [{ id: 'q1', status: 'processing' }],
        action: 'processing',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-B/queue');
    expect(mockClearThreadActiveInvocation).toHaveBeenCalledWith('thread-B');
    expect(mockReplaceThreadTargetCats).toHaveBeenCalledWith('thread-B', ['gpt52']);
    expect(mockUpdateThreadCatStatus).toHaveBeenCalledWith('thread-B', 'gpt52', 'streaming');
    // F173 PR-C Task 10: reconcile uses thread-scoped writer; first arg is threadId.
    expect(mockAddActiveInvocation).toHaveBeenCalledWith(
      'thread-B',
      'hydrated-thread-B-gpt52',
      'gpt52',
      'execute',
      1234,
    );
  });

  it('ignores stale queue-processing hydrate after current-thread done is followed by queue completion', async () => {
    mockStoreCurrentThreadId = 'thread-B';

    let resolveQueueJson: ((value: { activeInvocations: Array<{ catId: string; startedAt: number }> }) => void) | null =
      null;
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        new Promise<{ activeInvocations: Array<{ catId: string; startedAt: number }> }>((resolve) => {
          resolveQueueJson = resolve;
        }),
    });

    const onMessage = vi.fn();
    const callbacks: SocketCallbacks = { onMessage };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    await act(async () => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [{ id: 'q1', status: 'processing' }],
        action: 'processing',
      });
      await Promise.resolve();
    });

    act(() => {
      simulateServerEvent('agent_message', {
        type: 'done',
        catId: 'gpt52',
        threadId: 'thread-B',
        isFinal: true,
        timestamp: Date.now(),
      });
    });

    act(() => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [],
        action: 'completed',
      });
    });

    await act(async () => {
      resolveQueueJson?.({ activeInvocations: [{ catId: 'gpt52', startedAt: 1234 }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'done',
        threadId: 'thread-B',
        catId: 'gpt52',
        isFinal: true,
      }),
    );
    expect(mockReplaceThreadTargetCats).not.toHaveBeenCalled();
    expect(mockUpdateThreadCatStatus).not.toHaveBeenCalled();
    expect(mockAddActiveInvocation).not.toHaveBeenCalled();
  });

  it('keeps queue-processing hydrate alive when done is non-final and another cat may still be running', async () => {
    mockStoreCurrentThreadId = 'thread-B';

    let resolveQueueJson: ((value: { activeInvocations: Array<{ catId: string; startedAt: number }> }) => void) | null =
      null;
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        new Promise<{ activeInvocations: Array<{ catId: string; startedAt: number }> }>((resolve) => {
          resolveQueueJson = resolve;
        }),
    });

    const onMessage = vi.fn();
    const callbacks: SocketCallbacks = { onMessage };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    await act(async () => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [{ id: 'q1', status: 'processing' }],
        action: 'processing',
      });
      await Promise.resolve();
    });

    act(() => {
      simulateServerEvent('agent_message', {
        type: 'done',
        catId: 'gpt52',
        threadId: 'thread-B',
        isFinal: false,
        timestamp: Date.now(),
      });
    });

    await act(async () => {
      resolveQueueJson?.({ activeInvocations: [{ catId: 'codex', startedAt: 5678 }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'done',
        threadId: 'thread-B',
        catId: 'gpt52',
        isFinal: false,
      }),
    );
    expect(mockReplaceThreadTargetCats).toHaveBeenCalledWith('thread-B', ['codex']);
    expect(mockUpdateThreadCatStatus).toHaveBeenCalledWith('thread-B', 'codex', 'streaming');
    expect(mockAddActiveInvocation).toHaveBeenCalledWith(
      'thread-B',
      'hydrated-thread-B-codex',
      'codex',
      'execute',
      5678,
    );
  });

  it('keeps queue-processing hydrate alive when a cat emits isFinal=true but queue still shows processing', async () => {
    mockStoreCurrentThreadId = 'thread-B';

    let resolveQueueJson: ((value: { activeInvocations: Array<{ catId: string; startedAt: number }> }) => void) | null =
      null;
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        new Promise<{ activeInvocations: Array<{ catId: string; startedAt: number }> }>((resolve) => {
          resolveQueueJson = resolve;
        }),
    });

    const onMessage = vi.fn();
    const callbacks: SocketCallbacks = { onMessage };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    await act(async () => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [{ id: 'q1', status: 'processing' }],
        action: 'processing',
      });
      await Promise.resolve();
    });

    act(() => {
      simulateServerEvent('agent_message', {
        type: 'done',
        catId: 'gpt52',
        threadId: 'thread-B',
        isFinal: true,
        timestamp: Date.now(),
      });
    });

    await act(async () => {
      resolveQueueJson?.({ activeInvocations: [{ catId: 'codex', startedAt: 6789 }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'done',
        threadId: 'thread-B',
        catId: 'gpt52',
        isFinal: true,
      }),
    );
    expect(mockReplaceThreadTargetCats).toHaveBeenCalledWith('thread-B', ['codex']);
    expect(mockUpdateThreadCatStatus).toHaveBeenCalledWith('thread-B', 'codex', 'streaming');
    expect(mockAddActiveInvocation).toHaveBeenCalledWith(
      'thread-B',
      'hydrated-thread-B-codex',
      'codex',
      'execute',
      6789,
    );
  });

  it('keeps queue-processing hydrate alive when cleared only removes queued siblings in the background', async () => {
    mockStoreCurrentThreadId = 'thread-B';

    let resolveQueueJson: ((value: { activeInvocations: Array<{ catId: string; startedAt: number }> }) => void) | null =
      null;
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        new Promise<{ activeInvocations: Array<{ catId: string; startedAt: number }> }>((resolve) => {
          resolveQueueJson = resolve;
        }),
    });

    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    await act(async () => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [{ id: 'q1', status: 'processing' }],
        action: 'processing',
      });
      await Promise.resolve();
    });

    mockStoreCurrentThreadId = 'thread-C';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-C' }));
    });

    act(() => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [],
        action: 'cleared',
      });
    });

    mockStoreCurrentThreadId = 'thread-B';
    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    await act(async () => {
      resolveQueueJson?.({ activeInvocations: [{ catId: 'gpt52', startedAt: 1234 }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockReplaceThreadTargetCats).toHaveBeenCalledWith('thread-B', ['gpt52']);
    expect(mockUpdateThreadCatStatus).toHaveBeenCalledWith('thread-B', 'gpt52', 'streaming');
    expect(mockAddActiveInvocation).toHaveBeenCalledWith(
      'thread-B',
      'hydrated-thread-B-gpt52',
      'gpt52',
      'execute',
      1234,
    );
  });

  it('invalidates completed-state hydrate before a stale processing fetch resolves', async () => {
    mockStoreCurrentThreadId = 'thread-B';

    let resolveQueueJson: ((value: { activeInvocations: Array<{ catId: string; startedAt: number }> }) => void) | null =
      null;
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        new Promise<{ activeInvocations: Array<{ catId: string; startedAt: number }> }>((resolve) => {
          resolveQueueJson = resolve;
        }),
    });

    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    await act(async () => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [{ id: 'q1', status: 'processing' }],
        action: 'processing',
      });
      await Promise.resolve();
    });

    act(() => {
      simulateServerEvent('queue_updated', {
        threadId: 'thread-B',
        queue: [],
        action: 'completed',
      });
    });

    await act(async () => {
      resolveQueueJson?.({ activeInvocations: [{ catId: 'gpt52', startedAt: 1234 }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockReplaceThreadTargetCats).not.toHaveBeenCalled();
    expect(mockUpdateThreadCatStatus).not.toHaveBeenCalled();
    expect(mockAddActiveInvocation).not.toHaveBeenCalled();
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

  // thread_summary tests removed (clowder-ai#343): listener and callback no longer exist.

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

  it('scheduler lifecycle connector_message shows toast instead of appending a thread message', () => {
    mockStoreCurrentThreadId = 'thread-B';
    const callbacks: SocketCallbacks = { onMessage: vi.fn() };

    act(() => {
      root.render(React.createElement(HookWrapper, { callbacks, threadId: 'thread-B' }));
    });

    act(() => {
      simulateServerEvent('connector_message', {
        threadId: 'thread-B',
        message: {
          id: 'scheduler-toast-1',
          type: 'connector',
          content: '「喝水提醒」下次执行时间：2026-04-13 09:00:00',
          source: { connector: 'scheduler', label: '定时任务', icon: 'scheduler' },
          extra: {
            scheduler: {
              toast: {
                type: 'info',
                title: '定时任务已创建',
                message: '「喝水提醒」下次执行时间：2026-04-13 09:00:00',
                duration: 3200,
                lifecycleEvent: 'registered',
              },
            },
          },
          timestamp: Date.now(),
        },
      });
    });

    expect(mockAddMessageToThread).not.toHaveBeenCalled();
    expect(mockAddToast).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        title: '定时任务已创建',
        threadId: 'thread-B',
      }),
    );
  });
});
