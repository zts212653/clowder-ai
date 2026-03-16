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
});
