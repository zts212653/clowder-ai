import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

const mockAddMessage = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockSetStreaming = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
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
  clearAllActiveInvocations: mockClearAllActiveInvocations,
  setIntentMode: mockSetIntentMode,
  setCatStatus: mockSetCatStatus,
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: mockSetMessageUsage,
  requestStreamCatchUp: mockRequestStreamCatchUp,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-1',
};

let captured: ReturnType<typeof useAgentMessages> | undefined;

vi.mock('@/stores/chatStore', () => {
  const useChatStoreMock = Object.assign(() => storeState, { getState: () => storeState });
  return {
    useChatStore: useChatStoreMock,
  };
});

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
    mockGetThreadState.mockClear();
    mockGetThreadState.mockImplementation(() => ({ messages: [] }));
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

  it('routes timeout to original thread after switching active thread', () => {
    vi.useFakeTimers();
    try {
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

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(mockAddMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          content: '⏱ Response timed out. The operation may still be running in the background.',
        }),
      );
      expect(mockAddMessageToThread).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          type: 'system',
          variant: 'info',
          content: '⏱ Response timed out. The operation may still be running in the background.',
        }),
      );
      expect(mockResetThreadInvocationState).toHaveBeenCalledWith('thread-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopping a background thread does not clear active thread invocation state', () => {
    const cancelInvocation = vi.fn();
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
      captured?.handleStop(cancelInvocation, 'thread-2');
    });

    expect(cancelInvocation).toHaveBeenCalledWith('thread-2');
    expect(mockResetThreadInvocationState).toHaveBeenCalledWith('thread-2');
    expect(mockSetThreadMessageStreaming).toHaveBeenCalledWith('thread-2', 'bg-stream-1', false);

    // Active thread state must remain untouched.
    expect(mockSetLoading).not.toHaveBeenCalledWith(false);
    expect(mockSetHasActiveInvocation).not.toHaveBeenCalledWith(false);
    expect(mockSetIntentMode).not.toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).not.toHaveBeenCalled();
    expect(mockSetStreaming).not.toHaveBeenCalled();
  });

  it('stopping a background thread clears its pending timeout guard', () => {
    vi.useFakeTimers();
    try {
      const cancelInvocation = vi.fn();

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
        captured?.handleStop(cancelInvocation, 'thread-1');
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

  it('stopping another thread does not clear active thread timeout guard', () => {
    vi.useFakeTimers();
    try {
      const cancelInvocation = vi.fn();

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
        captured?.handleStop(cancelInvocation, 'thread-1');
      });

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(mockAddMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '⏱ Response timed out. The operation may still be running in the background.',
        }),
      );
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
