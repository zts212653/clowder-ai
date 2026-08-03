import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

const mockSetCatStatus = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockAddMessage = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockAppendRichBlock = vi.fn();
const mockSetStreaming = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetIntentMode = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetMessageUsage = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockSetMessageMetadata = vi.fn();
const mockSetMessageThinking = vi.fn();

const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({ messages: [] }));
const mockUpdateThreadCatStatus = vi.fn();
const mockSetThreadCatInvocation = vi.fn();

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
  appendRichBlock: mockAppendRichBlock,
  setStreaming: mockSetStreaming,
  setLoading: mockSetLoading,
  setHasActiveInvocation: mockSetHasActiveInvocation,
  setIntentMode: mockSetIntentMode,
  setCatStatus: mockSetCatStatus,
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: mockSetMessageUsage,
  requestStreamCatchUp: mockRequestStreamCatchUp,
  setMessageMetadata: mockSetMessageMetadata,
  setMessageThinking: mockSetMessageThinking,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  updateThreadCatStatus: mockUpdateThreadCatStatus,
  setThreadCatInvocation: mockSetThreadCatInvocation,
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

describe('F118 useAgentMessages liveness warning', () => {
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('sets catStatus to alive_but_silent on liveness_warning system_info', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({
          type: 'liveness_warning',
          __livenessWarning: true,
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 125000,
          cpuTimeMs: 4200,
          processAlive: true,
          firstEventAt: 1000,
          lastEventAt: 2000,
          lastEventType: 'turn.started',
        }),
      });
    });

    expect(mockSetCatStatus).toHaveBeenCalledWith('codex', 'alive_but_silent');
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        livenessWarning: expect.objectContaining({
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 125000,
          firstEventAt: 1000,
          lastEventAt: 2000,
          lastEventType: 'turn.started',
        }),
      }),
    );
  });

  it('sets catStatus to suspected_stall on stall warning', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({
          type: 'liveness_warning',
          __livenessWarning: true,
          level: 'suspected_stall',
          state: 'idle-silent',
          silenceDurationMs: 310000,
          processAlive: true,
        }),
      });
    });

    expect(mockSetCatStatus).toHaveBeenCalledWith('codex', 'suspected_stall');
  });

  it('does not render liveness_warning as a system message bubble', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({
          type: 'liveness_warning',
          __livenessWarning: true,
          level: 'alive_but_silent',
          state: 'busy-silent',
          silenceDurationMs: 125000,
          processAlive: true,
        }),
      });
    });

    // Should NOT add a system message bubble
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('stores app-server lifecycle without rendering raw JSON', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({
          type: 'app_server_lifecycle',
          stage: 'active',
          lastActivityAt: 123_456,
          recoveryAttempt: 1,
          threadId: 'thread-1',
          turnId: 'turn-1',
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: true,
        }),
      });
    });

    expect(mockSetCatStatus).toHaveBeenCalledWith('codex', 'streaming');
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        appServerLifecycle: expect.objectContaining({
          stage: 'active',
          lastActivityAt: 123_456,
          recoveryAttempt: 1,
          threadId: 'thread-1',
          turnId: 'turn-1',
        }),
      }),
    );
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('stores app-server lifecycle from the backward-compatible status channel without a bubble', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'status',
        catId: 'codex',
        content: 'streaming',
        metadata: {
          provider: 'openai',
          model: 'gpt-5.6-sol',
          diagnostics: {
            appServerLifecycle: {
              stage: 'active',
              lastActivityAt: 123_456,
              recoveryAttempt: 1,
              threadId: 'thread-1',
              turnId: 'turn-1',
              turnStartSent: true,
              turnAccepted: true,
              itemObserved: true,
            },
          },
        },
      });
    });

    expect(mockSetCatStatus).toHaveBeenCalledWith('codex', 'streaming');
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        appServerLifecycle: expect.objectContaining({
          stage: 'active',
          threadId: 'thread-1',
          turnId: 'turn-1',
        }),
      }),
    );
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('stores background app-server lifecycle from status without a bubble', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'status',
        catId: 'codex',
        threadId: 'thread-2',
        timestamp: 123_456,
        content: 'streaming',
        metadata: {
          provider: 'openai',
          model: 'gpt-5.6-sol',
          diagnostics: {
            appServerLifecycle: {
              stage: 'active',
              lastActivityAt: 123_456,
              recoveryAttempt: 0,
              threadId: 'thread-1',
              turnId: 'turn-1',
              turnStartSent: true,
              turnAccepted: true,
              itemObserved: true,
            },
          },
        },
      });
    });

    expect(mockUpdateThreadCatStatus).toHaveBeenCalledWith('thread-2', 'codex', 'streaming');
    expect(mockSetThreadCatInvocation).toHaveBeenCalledWith(
      'thread-2',
      'codex',
      expect.objectContaining({
        appServerLifecycle: expect.objectContaining({ stage: 'active', turnId: 'turn-1' }),
      }),
    );
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });

  it('preserves an app-server transport failure reason without rendering raw JSON', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({
          type: 'app_server_lifecycle',
          stage: 'failed',
          lastActivityAt: 123_456,
          recoveryAttempt: 0,
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: false,
          failureReason: 'transport lost after acceptance',
        }),
      });
    });

    expect(mockSetCatStatus).toHaveBeenCalledWith('codex', 'error');
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        appServerLifecycle: expect.objectContaining({
          stage: 'failed',
          failureReason: 'transport lost after acceptance',
        }),
      }),
    );
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('projects pre-turn recovery as spawning status without a bubble', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'app_server_recovery', attempt: 1, retryBudget: 1 }),
      });
    });

    expect(mockSetCatStatus).toHaveBeenCalledWith('codex', 'spawning');
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('projects pre-turn recovery from the backward-compatible status channel without a bubble', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'status',
        catId: 'codex',
        content: 'thinking',
        metadata: {
          provider: 'openai',
          model: 'gpt-5.6-sol',
          diagnostics: {
            appServerRecovery: { type: 'app_server.recovery', attempt: 1, retryBudget: 1 },
          },
        },
      });
    });

    expect(mockSetCatStatus).toHaveBeenCalledWith('codex', 'spawning');
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});
