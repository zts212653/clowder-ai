import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectInvocationTimeoutCandidates,
  INVOCATION_RECONCILIATION_POLL_MS,
  reconcileTimedOutInvocations,
  terminalizeInvocationReconciliation,
} from '@/hooks/invocation-timeout-reconciliation';
import { useAgentMessages } from '@/hooks/useAgentMessages';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

const mockAddMessage = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockSetStreaming = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockRemoveActiveInvocation = vi.fn();
const mockClearAllActiveInvocations = vi.fn(() => {
  mockSetHasActiveInvocation(false);
});
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockSetMessageUsage = vi.fn();
const mockRequestStreamCatchUp = vi.fn();

const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockRemoveThreadActiveInvocation = vi.fn();
const mockPatchThreadMessage = vi.fn();
const mockSetThreadCatInvocation = vi.fn();
const mockSetThreadLoading = vi.fn();
const mockUpdateThreadCatStatus = vi.fn();
const mockGetThreadState: ReturnType<
  typeof vi.fn<
    (tid?: string) => {
      messages: Array<{
        id: string;
        type: string;
        catId?: string;
        content: string;
        isStreaming?: boolean;
        timestamp: number;
      }>;
      activeInvocations?: Record<string, { catId: string; mode: string }>;
      catInvocations?: Record<string, { invocationId?: string; turnInvocationId?: string }>;
    }
  >
> = vi.fn(() => ({
  messages: [] as Array<{
    id: string;
    type: string;
    catId?: string;
    content: string;
    isStreaming?: boolean;
    timestamp: number;
  }>,
}));

const storeState = {
  messages: [] as Array<{
    id: string;
    type: string;
    catId?: string;
    content: string;
    isStreaming?: boolean;
    timestamp: number;
  }>,
  addMessage: mockAddMessage,
  appendToMessage: mockAppendToMessage,
  appendToolEvent: mockAppendToolEvent,
  setStreaming: mockSetStreaming,
  setLoading: mockSetLoading,
  setHasActiveInvocation: mockSetHasActiveInvocation,
  removeActiveInvocation: mockRemoveActiveInvocation,
  clearAllActiveInvocations: mockClearAllActiveInvocations,
  setIntentMode: mockSetIntentMode,
  setCatStatus: mockSetCatStatus,
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: mockSetMessageUsage,
  requestStreamCatchUp: mockRequestStreamCatchUp,
  catInvocations: {} as Record<string, { invocationId?: string; turnInvocationId?: string }>,

  addMessageToThread: mockAddMessageToThread,
  // F183 B1.2.3: active stream new-bubble path → reducer → replaceMessages
  replaceMessages: vi.fn((msgs: unknown[]) => {
    storeState.messages = msgs as typeof storeState.messages;
  }),
  hasMore: true,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  removeThreadActiveInvocation: mockRemoveThreadActiveInvocation,
  patchThreadMessage: mockPatchThreadMessage,
  setThreadCatInvocation: mockSetThreadCatInvocation,
  setThreadLoading: mockSetThreadLoading,
  updateThreadCatStatus: mockUpdateThreadCatStatus,
  getThreadState: mockGetThreadState,
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
  currentThreadId: 'thread-1',
};

let captured: ReturnType<typeof useAgentMessages> | undefined;

vi.mock('@/stores/chatStore', () => {
  const useChatStoreMock = Object.assign(() => storeState, { getState: () => storeState });
  return {
    useChatStore: useChatStoreMock,
  };
});

vi.mock('@/utils/api-client', () => ({ apiFetch: mockApiFetch }));

function Harness() {
  captured = useAgentMessages();
  return null;
}

describe('useAgentMessages loading lifecycle', () => {
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
    captured = undefined;
    storeState.messages = [];
    mockAddMessage.mockClear();
    mockAppendToMessage.mockClear();
    mockAppendToolEvent.mockClear();
    mockSetStreaming.mockClear();
    mockSetLoading.mockClear();
    mockSetHasActiveInvocation.mockClear();
    mockRemoveActiveInvocation.mockClear();
    mockClearAllActiveInvocations.mockClear();
    mockSetIntentMode.mockClear();
    mockSetCatStatus.mockClear();
    mockClearCatStatuses.mockClear();
    mockSetCatInvocation.mockClear();
    mockSetMessageUsage.mockClear();

    mockAddMessageToThread.mockClear();
    mockClearThreadActiveInvocation.mockClear();
    mockResetThreadInvocationState.mockClear();
    mockSetThreadMessageStreaming.mockClear();
    mockRemoveThreadActiveInvocation.mockClear();
    mockPatchThreadMessage.mockClear();
    mockSetThreadCatInvocation.mockClear();
    mockSetThreadLoading.mockClear();
    mockUpdateThreadCatStatus.mockClear();
    mockApiFetch.mockReset();
    mockGetThreadState.mockClear();
    mockGetThreadState.mockImplementation(() => ({ messages: [] }));
    storeState.activeInvocations = {};
    storeState.catInvocations = {};
    storeState.currentThreadId = 'thread-1';
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('clears loading when final done is received', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    expect(captured).toBeTruthy();
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        isFinal: true,
      });
    });

    expect(mockSetLoading).toHaveBeenCalledWith(false);
    expect(mockSetHasActiveInvocation).toHaveBeenCalledWith(false);
    expect(mockSetIntentMode).toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).toHaveBeenCalled();
  });

  it('clears hasActiveInvocation on error with isFinal', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'error',
        catId: 'opus',
        error: 'something broke',
        isFinal: true,
      });
    });

    expect(mockSetLoading).toHaveBeenCalledWith(false);
    expect(mockSetHasActiveInvocation).toHaveBeenCalledWith(false);
    expect(mockSetIntentMode).toHaveBeenCalledWith(null);
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'error',
        content: 'Error: something broke',
      }),
    );
  });

  it('closes existing streaming bubble on done even when activeRefs are empty', () => {
    storeState.messages = [
      {
        id: 'bg-msg-1',
        type: 'assistant',
        catId: 'codex',
        content: 'partial',
        isStreaming: true,
        timestamp: Date.now(),
      },
    ];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
      });
    });

    expect(mockSetStreaming).toHaveBeenCalledWith('bg-msg-1', false);
  });

  it('keeps handleAgentMessage stable when only messages change', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    const firstHandler = captured?.handleAgentMessage;
    expect(firstHandler).toBeTruthy();

    storeState.messages = [
      {
        id: 'msg-new',
        type: 'assistant',
        catId: 'codex',
        content: 'delta',
        isStreaming: true,
        timestamp: Date.now(),
      },
    ];

    act(() => {
      root.render(React.createElement(Harness));
    });

    expect(captured?.handleAgentMessage).toBe(firstHandler);
  });

  it('prefers the fresh active slot over a stale cat invocation mapping', () => {
    expect(
      collectInvocationTimeoutCandidates(
        { 'inv-fresh': { catId: 'codex', mode: 'execute' } },
        { codex: { invocationId: 'inv-stale', turnInvocationId: 'turn-stale' } },
      ),
    ).toEqual([
      {
        invocationId: 'inv-fresh',
        slotKeys: ['inv-fresh'],
        catIds: ['codex'],
        turnInvocationIds: [],
      },
    ]);
  });

  it('reconciles the original invocation without dropping identity after switching threads', async () => {
    vi.useFakeTimers();
    try {
      storeState.activeInvocations = {
        'inv-1261': { catId: 'codex', mode: 'execute' },
      };
      storeState.catInvocations = {
        codex: { invocationId: 'inv-1261', turnInvocationId: 'turn-1261' },
      };
      mockGetThreadState.mockImplementation((threadId?: string) => {
        const activeInvocations: Record<string, { catId: string; mode: string }> =
          threadId === 'thread-1' ? { 'inv-1261': { catId: 'codex', mode: 'execute' } } : {};
        const catInvocations: Record<string, { invocationId?: string; turnInvocationId?: string }> =
          threadId === 'thread-1' ? { codex: { invocationId: 'inv-1261', turnInvocationId: 'turn-1261' } } : {};
        return { messages: [], activeInvocations, catInvocations };
      });
      mockApiFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'inv-1261', threadId: 'thread-1', status: 'running', updatedAt: Date.now() }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          catId: 'codex',
          content: 'partial',
        });
      });

      // Simulate user switching from thread-1 to thread-2 while old invocation is still active.
      storeState.currentThreadId = 'thread-2';

      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockAddMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          content: '⏱ Response timed out. The operation may still be running in the background.',
        }),
      );
      expect(mockAddMessageToThread).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          id: 'invocation-status-inv-1261',
          type: 'system',
          variant: 'info',
          content: expect.stringContaining('inv-1261'),
          extra: expect.objectContaining({
            invocationReconciliation: expect.objectContaining({
              invocationId: 'inv-1261',
              turnInvocationIds: ['turn-1261'],
              phase: 'running',
            }),
          }),
        }),
      );
      expect(mockApiFetch).toHaveBeenCalledWith('/api/invocations/inv-1261');
      expect(mockResetThreadInvocationState).not.toHaveBeenCalled();
      expect(mockRemoveThreadActiveInvocation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminalizes only the failed invocation discovered by timeout reconciliation', async () => {
    vi.useFakeTimers();
    try {
      storeState.activeInvocations = {
        'inv-failed': { catId: 'codex', mode: 'execute' },
        'inv-running-opus': { catId: 'opus', mode: 'execute' },
      };
      storeState.catInvocations = {
        codex: { invocationId: 'inv-failed', turnInvocationId: 'turn-failed' },
        opus: { invocationId: 'inv-running', turnInvocationId: 'turn-running' },
      };
      mockGetThreadState.mockImplementation(() => ({
        messages: [],
        activeInvocations: storeState.activeInvocations,
        catInvocations: storeState.catInvocations,
      }));
      mockApiFetch.mockImplementation(async (path: string) => {
        const payload = path.endsWith('/inv-failed')
          ? {
              id: 'inv-failed',
              threadId: 'thread-1',
              status: 'failed',
              error: 'provider rejected the configured model',
              updatedAt: Date.now(),
            }
          : { id: 'inv-running', threadId: 'thread-1', status: 'running', updatedAt: Date.now() };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      act(() => {
        root.render(React.createElement(Harness));
      });
      act(() => {
        captured?.handleAgentMessage({ type: 'text', catId: 'codex', content: 'partial' });
      });

      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockClearAllActiveInvocations).not.toHaveBeenCalled();
      expect(mockRemoveThreadActiveInvocation).toHaveBeenCalledWith('thread-1', 'inv-failed');
      expect(mockRemoveThreadActiveInvocation).not.toHaveBeenCalledWith('thread-1', 'inv-running-opus');
      expect(mockSetCatInvocation).toHaveBeenCalledWith('codex', {
        invocationId: undefined,
        turnInvocationId: undefined,
      });
      expect(mockAddMessageToThread).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          id: 'invocation-status-inv-failed',
          variant: 'error',
          content: expect.stringContaining('provider rejected the configured model'),
        }),
      );
      expect(mockAddMessageToThread).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          id: 'invocation-status-inv-running',
          variant: 'info',
          content: expect.stringContaining('inv-running'),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('patches the same running timeout notice when socket done wins before the next HTTP poll', async () => {
    vi.useFakeTimers();
    try {
      storeState.activeInvocations = {
        'inv-socket-terminal': { catId: 'codex', mode: 'execute' },
      };
      storeState.catInvocations = {
        codex: { invocationId: 'inv-socket-terminal', turnInvocationId: 'turn-socket-terminal' },
      };
      mockGetThreadState.mockImplementation(() => ({
        messages: storeState.messages,
        activeInvocations: storeState.activeInvocations,
        catInvocations: storeState.catInvocations,
      }));
      mockApiFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'inv-socket-terminal',
            threadId: 'thread-1',
            status: 'running',
            updatedAt: Date.now(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      act(() => root.render(React.createElement(Harness)));
      act(() => captured?.handleAgentMessage({ type: 'text', catId: 'codex', content: 'partial' }));
      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000);
        await Promise.resolve();
        await Promise.resolve();
      });

      const runningNotice = mockAddMessageToThread.mock.calls.find(
        ([threadId, message]) => threadId === 'thread-1' && message.id === 'invocation-status-inv-socket-terminal',
      )?.[1];
      expect(runningNotice).toBeTruthy();
      storeState.messages = [runningNotice];

      act(() => {
        captured?.handleAgentMessage({
          type: 'done',
          catId: 'codex',
          invocationId: 'inv-socket-terminal',
          turnInvocationId: 'turn-socket-terminal',
          isFinal: true,
        });
      });

      expect(mockPatchThreadMessage).toHaveBeenCalledWith(
        'thread-1',
        'invocation-status-inv-socket-terminal',
        expect.objectContaining({
          content: expect.stringContaining('completed'),
          extra: expect.objectContaining({
            invocationReconciliation: expect.objectContaining({ phase: 'succeeded' }),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not clear a newer child identity when a late terminal shares the same parent', () => {
    mockGetThreadState.mockImplementation(() => ({
      messages: [],
      activeInvocations: { 'parent-shared': { catId: 'codex', mode: 'execute' } },
      catInvocations: {
        codex: { invocationId: 'parent-shared', turnInvocationId: 'turn-new' },
      },
    }));

    terminalizeInvocationReconciliation({
      threadId: 'thread-1',
      invocationId: 'parent-shared',
      phase: 'succeeded',
      catId: 'codex',
      turnInvocationId: 'turn-old',
      projectNotice: false,
    });

    expect(mockSetThreadCatInvocation).not.toHaveBeenCalled();
    expect(mockSetCatInvocation).not.toHaveBeenCalled();
  });

  it('does not end a newer parent status or bubble when an old parent HTTP terminal reconciles', () => {
    mockGetThreadState.mockImplementation(() => ({
      messages: [
        {
          id: 'bubble-parent-new',
          type: 'assistant',
          catId: 'codex',
          content: 'new invocation still streaming',
          isStreaming: true,
          timestamp: Date.now(),
        },
      ],
      activeInvocations: {
        'parent-old': { catId: 'codex', mode: 'execute' },
        'parent-new': { catId: 'codex', mode: 'execute' },
      },
      catInvocations: {
        codex: { invocationId: 'parent-new', turnInvocationId: 'turn-new' },
      },
    }));

    terminalizeInvocationReconciliation({
      threadId: 'thread-1',
      invocationId: 'parent-old',
      phase: 'succeeded',
      candidate: {
        invocationId: 'parent-old',
        slotKeys: ['parent-old'],
        catIds: ['codex'],
        turnInvocationIds: ['turn-old'],
      },
      removeActiveSlots: true,
    });

    expect(mockRemoveThreadActiveInvocation).toHaveBeenCalledWith('thread-1', 'parent-old');
    expect(mockRemoveThreadActiveInvocation).not.toHaveBeenCalledWith('thread-1', 'parent-new');
    expect(mockUpdateThreadCatStatus).not.toHaveBeenCalledWith('thread-1', 'codex', 'done');
    expect(mockSetThreadMessageStreaming).not.toHaveBeenCalledWith('thread-1', 'bubble-parent-new', false);
  });

  it('keeps the first terminal timeout projection when a late terminal disagrees', () => {
    const terminalNotice = {
      id: 'invocation-status-inv-terminal-once',
      type: 'system',
      variant: 'info',
      content: 'Execution completed.',
      timestamp: Date.now(),
      extra: {
        invocationReconciliation: {
          v: 1 as const,
          invocationId: 'inv-terminal-once',
          catIds: ['codex'],
          turnInvocationIds: ['turn-terminal-once'],
          phase: 'succeeded' as const,
          updatedAt: Date.now(),
        },
      },
    };
    mockGetThreadState.mockImplementation(() => ({
      messages: [terminalNotice],
      activeInvocations: {},
      catInvocations: {},
    }));

    terminalizeInvocationReconciliation({
      threadId: 'thread-1',
      invocationId: 'inv-terminal-once',
      phase: 'failed',
      catId: 'codex',
      turnInvocationId: 'turn-terminal-once',
      error: 'late failure',
    });

    expect(mockPatchThreadMessage).not.toHaveBeenCalled();
  });

  it('retains an unknown-running slot when the canonical record cannot be read', async () => {
    vi.useFakeTimers();
    try {
      storeState.activeInvocations = {
        'inv-unknown': { catId: 'codex', mode: 'execute' },
      };
      storeState.catInvocations = {
        codex: { invocationId: 'inv-unknown', turnInvocationId: 'turn-unknown' },
      };
      mockGetThreadState.mockImplementation(() => ({
        messages: [],
        activeInvocations: storeState.activeInvocations,
        catInvocations: storeState.catInvocations,
      }));
      mockApiFetch.mockResolvedValue(
        new Response(JSON.stringify({ code: 'INVOCATION_NOT_FOUND' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );

      act(() => root.render(React.createElement(Harness)));
      act(() => captured?.handleAgentMessage({ type: 'text', catId: 'codex', content: 'partial' }));
      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockRemoveThreadActiveInvocation).not.toHaveBeenCalled();
      expect(mockAddMessageToThread).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          id: 'invocation-status-inv-unknown',
          extra: expect.objectContaining({
            invocationReconciliation: expect.objectContaining({
              phase: 'unknown_running',
              reason: 'record_not_found',
            }),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps reconciling canonical truth until a running invocation terminalizes exactly once', async () => {
    vi.useFakeTimers();
    try {
      storeState.activeInvocations = {
        'inv-continuous': { catId: 'codex', mode: 'execute' },
      };
      storeState.catInvocations = {
        codex: { invocationId: 'inv-continuous', turnInvocationId: 'turn-continuous' },
      };
      mockGetThreadState.mockImplementation(() => ({
        messages: [],
        activeInvocations: storeState.activeInvocations,
        catInvocations: storeState.catInvocations,
      }));
      mockApiFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'inv-continuous',
              threadId: 'thread-1',
              status: 'running',
              updatedAt: Date.now(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'inv-continuous',
              threadId: 'thread-1',
              status: 'succeeded',
              updatedAt: Date.now() + INVOCATION_RECONCILIATION_POLL_MS,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );

      await reconcileTimedOutInvocations('thread-1');
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
      expect(mockRemoveThreadActiveInvocation).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(INVOCATION_RECONCILIATION_POLL_MS);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockApiFetch).toHaveBeenCalledTimes(2);
      expect(mockRemoveThreadActiveInvocation).toHaveBeenCalledTimes(1);
      expect(mockRemoveThreadActiveInvocation).toHaveBeenCalledWith('thread-1', 'inv-continuous');
      expect(mockAddMessageToThread).toHaveBeenLastCalledWith(
        'thread-1',
        expect.objectContaining({
          id: 'invocation-status-inv-continuous',
          extra: expect.objectContaining({
            invocationReconciliation: expect.objectContaining({ phase: 'succeeded' }),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect a timeout result after a terminal event wins the query race', async () => {
    vi.useFakeTimers();
    try {
      storeState.activeInvocations = {
        'inv-race': { catId: 'codex', mode: 'execute' },
      };
      storeState.catInvocations = {
        codex: { invocationId: 'inv-race', turnInvocationId: 'turn-race' },
      };
      mockGetThreadState.mockImplementation(() => ({
        messages: [],
        activeInvocations: storeState.activeInvocations,
        catInvocations: storeState.catInvocations,
      }));
      let resolveRecord: ((response: Response) => void) | undefined;
      mockApiFetch.mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveRecord = resolve;
        }),
      );

      act(() => root.render(React.createElement(Harness)));
      act(() => captured?.handleAgentMessage({ type: 'text', catId: 'codex', content: 'partial' }));
      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000);
        await Promise.resolve();
      });

      // Model the socket terminal handler winning while the canonical query is in flight.
      storeState.activeInvocations = {};
      await act(async () => {
        resolveRecord?.(
          new Response(
            JSON.stringify({ id: 'inv-race', threadId: 'thread-1', status: 'failed', updatedAt: Date.now() }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockAddMessageToThread).not.toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ id: 'invocation-status-inv-race' }),
      );
      expect(mockRemoveThreadActiveInvocation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopping a background thread does not clear active thread invocation state', () => {
    const cancelInvocation = vi.fn(() => true);
    const stopIntent = {
      sourceControl: 'chat_input_action' as const,
      gesture: 'pointer' as const,
      trustedGesture: true,
    };
    mockGetThreadState.mockImplementation((tid?: string) => {
      if (tid === 'thread-2') {
        return {
          messages: [
            {
              id: 'bg-stream-1',
              type: 'assistant',
              catId: 'opus',
              content: 'running',
              isStreaming: true,
              timestamp: Date.now(),
            },
          ],
        };
      }
      return { messages: [] };
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    // Seed activeRefs with an active-thread stream.
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        content: 'active stream chunk',
      });
    });

    act(() => {
      captured?.handleStop(cancelInvocation, 'thread-2', stopIntent);
    });

    expect(cancelInvocation).toHaveBeenCalledWith('thread-2', undefined, stopIntent);
    expect(mockResetThreadInvocationState).toHaveBeenCalledWith('thread-2');
    expect(mockSetThreadMessageStreaming).toHaveBeenCalledWith('thread-2', 'bg-stream-1', false);

    // Active thread state must remain untouched.
    expect(mockSetLoading).not.toHaveBeenCalledWith(false);
    expect(mockSetHasActiveInvocation).not.toHaveBeenCalledWith(false);
    expect(mockSetIntentMode).not.toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).not.toHaveBeenCalled();
    expect(mockSetStreaming).not.toHaveBeenCalled();
  });

  it('keeps local invocation state when the cancel packet is not sent', () => {
    const cancelInvocation = vi.fn(() => false);
    mockGetThreadState.mockImplementation(() => ({
      messages: [
        {
          id: 'still-streaming',
          type: 'assistant',
          catId: 'opus',
          content: 'still running',
          isStreaming: true,
          timestamp: Date.now(),
        },
      ],
    }));

    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleStop(cancelInvocation, 'thread-2', {
        sourceControl: 'chat_input_action',
        gesture: 'pointer',
        trustedGesture: false,
      });
    });

    expect(cancelInvocation).toHaveBeenCalledOnce();
    expect(mockResetThreadInvocationState).not.toHaveBeenCalled();
    expect(mockSetThreadMessageStreaming).not.toHaveBeenCalled();
  });

  it('composer Stop remains whole-thread even when the target thread has one active cat', () => {
    const cancelInvocation = vi.fn(() => true);
    const stopIntent = {
      sourceControl: 'chat_input_action' as const,
      gesture: 'pointer' as const,
      trustedGesture: true,
    };
    storeState.activeInvocations = {
      'inv-active': { catId: 'codex', mode: 'execute' },
    };

    mockGetThreadState.mockImplementation(((tid?: string) => {
      if (tid === 'thread-2') {
        return {
          messages: [] as Array<{
            id: string;
            type: string;
            catId?: string;
            content: string;
            isStreaming?: boolean;
            timestamp: number;
          }>,
          activeInvocations: {
            'inv-bg': { catId: 'opus', mode: 'execute' },
          },
        };
      }
      return {
        messages: [] as Array<{
          id: string;
          type: string;
          catId?: string;
          content: string;
          isStreaming?: boolean;
          timestamp: number;
        }>,
        activeInvocations: {
          'inv-active': { catId: 'codex', mode: 'execute' },
        },
      };
    }) as unknown as typeof mockGetThreadState);

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleStop(cancelInvocation, 'thread-2', stopIntent);
    });

    expect(cancelInvocation).toHaveBeenCalledWith('thread-2', undefined, stopIntent);
    expect(mockResetThreadInvocationState).toHaveBeenCalledWith('thread-2');
  });

  it('stopping a background thread clears its pending timeout guard', () => {
    vi.useFakeTimers();
    try {
      const cancelInvocation = vi.fn(() => true);

      act(() => {
        root.render(React.createElement(Harness));
      });

      // Arm timeout for thread-1.
      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          catId: 'codex',
          content: 'partial',
        });
      });

      // Switch active thread, then stop the old thread from split-pane context.
      storeState.currentThreadId = 'thread-2';
      act(() => {
        captured?.handleStop(cancelInvocation, 'thread-1', {
          sourceControl: 'chat_input_action',
          gesture: 'pointer',
          trustedGesture: true,
        });
      });

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(mockAddMessageToThread).not.toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          content: '⏱ Response timed out. The operation may still be running in the background.',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopping another thread does not clear the current thread timeout guard', () => {
    vi.useFakeTimers();
    try {
      const cancelInvocation = vi.fn(() => true);

      act(() => {
        root.render(React.createElement(Harness));
      });

      // Arm timeout for thread-1.
      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          catId: 'codex',
          content: 'thread-1 partial',
        });
      });

      // Switch to thread-2 and arm its timeout.
      storeState.currentThreadId = 'thread-2';
      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          catId: 'codex',
          content: 'thread-2 partial',
        });
      });

      // Stop old thread-1 from split-pane context.
      act(() => {
        captured?.handleStop(cancelInvocation, 'thread-1', {
          sourceControl: 'chat_input_action',
          gesture: 'pointer',
          trustedGesture: true,
        });
      });

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(mockResetThreadInvocationState).not.toHaveBeenCalledWith('thread-2');
      expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans timeout guard on unmount to prevent stale timeout side effects', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(Harness));
      });

      // Arm the done-timeout guard.
      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          catId: 'codex',
          content: 'partial',
        });
      });

      // Unmount hook instance (e.g. HMR / remount path).
      act(() => {
        root.render(null);
      });

      mockAddMessage.mockClear();
      mockAddMessageToThread.mockClear();
      mockSetLoading.mockClear();
      mockSetHasActiveInvocation.mockClear();
      mockSetIntentMode.mockClear();
      mockClearCatStatuses.mockClear();

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(mockAddMessage).not.toHaveBeenCalled();
      expect(mockAddMessageToThread).not.toHaveBeenCalled();
      expect(mockSetLoading).not.toHaveBeenCalled();
      expect(mockSetHasActiveInvocation).not.toHaveBeenCalled();
      expect(mockSetIntentMode).not.toHaveBeenCalled();
      expect(mockClearCatStatuses).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes existing streaming bubble on error even when activeRefs are empty', () => {
    storeState.messages = [
      {
        id: 'bg-msg-err',
        type: 'assistant',
        catId: 'opus',
        content: 'partial',
        isStreaming: true,
        timestamp: Date.now(),
      },
    ];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'error',
        catId: 'opus',
        error: 'failed',
      });
    });

    expect(mockSetStreaming).toHaveBeenCalledWith('bg-msg-err', false);
  });

  it('system_info context_health without parsed catId falls back to msg.catId', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    const payload = JSON.stringify({
      type: 'context_health',
      health: {
        usedTokens: 10,
        windowTokens: 200000,
        fillRatio: 0.00005,
        source: 'exact',
        measuredAt: Date.now(),
      },
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: payload,
      });
    });

    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'opus',
      expect.objectContaining({
        contextHealth: expect.objectContaining({ usedTokens: 10, windowTokens: 200000 }),
      }),
    );
    expect(mockSetCatInvocation).not.toHaveBeenCalledWith(undefined, expect.anything());
  });

  it('consumes system_info rate_limit silently (no raw JSON system bubble)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    const payload = JSON.stringify({
      type: 'rate_limit',
      catId: 'opus',
      utilization: 0.87,
      resetsAt: '2026-02-28T12:00:00Z',
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: payload,
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'opus',
      expect.objectContaining({
        rateLimit: expect.objectContaining({ utilization: 0.87, resetsAt: '2026-02-28T12:00:00Z' }),
      }),
    );
  });

  it('consumes system_info compact_boundary silently (no raw JSON system bubble)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    const payload = JSON.stringify({
      type: 'compact_boundary',
      catId: 'opus',
      preTokens: 42000,
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: payload,
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'opus',
      expect.objectContaining({
        compactBoundary: expect.objectContaining({ preTokens: 42000 }),
      }),
    );
  });
});
