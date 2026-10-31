import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import type { ChatMessage } from '@/stores/chat-types';

const mockAddMessage = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockAppendRichBlock = vi.fn();
const mockSetStreaming = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockUpdateThreadCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockSetMessageUsage = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockSetMessageMetadata = vi.fn();
const mockSetMessageThinking = vi.fn();
const mockRemoveMessage = vi.fn();
const mockPatchMessage = vi.fn();

const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({ messages: [] }));

const storeState = {
  messages: [] as ChatMessage[],
  addMessage: mockAddMessage,
  appendToMessage: mockAppendToMessage,
  appendToolEvent: mockAppendToolEvent,
  appendRichBlock: mockAppendRichBlock,
  setStreaming: mockSetStreaming,
  setLoading: mockSetLoading,
  setHasActiveInvocation: mockSetHasActiveInvocation,
  setIntentMode: mockSetIntentMode,
  setCatStatus: mockSetCatStatus,
  updateThreadCatStatus: mockUpdateThreadCatStatus,
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: mockSetMessageUsage,
  requestStreamCatchUp: mockRequestStreamCatchUp,
  setMessageMetadata: mockSetMessageMetadata,
  setMessageThinking: mockSetMessageThinking,
  removeMessage: mockRemoveMessage,
  patchMessage: mockPatchMessage,

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

describe('useAgentMessages system_info warning', () => {
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
    mockAddMessageToThread.mockClear();
    mockRemoveMessage.mockClear();
    mockPatchMessage.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders warning JSON as readable system message', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'gpt52',
        content: JSON.stringify({
          type: 'warning',
          presentation: 'user_action_required',
          catId: 'gpt52',
          message: 'hello',
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'info',
        content: '⚠️ hello',
      }),
    );
  });

  it('renders cloud bridge status as readable text instead of raw JSON', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'gpt-pro',
        content: JSON.stringify({
          type: 'cloud_bridge_status',
          catId: 'gpt-pro',
          status: 'unavailable',
          reason: 'no-adapter',
          message: '未发送给 @gpt-pro：还没有可用的后台 Host Adapter。',
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'info',
        content: '未发送给 @gpt-pro：还没有可用的后台 Host Adapter。',
      }),
    );
  });

  it.each([
    'reconnecting',
    'recovered',
    'failed',
  ])('does not create a result row for unnamed provider recovery %s', (phase) => {
    act(() => root.render(React.createElement(Harness)));
    act(() =>
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        invocationId: 'parent-inv',
        turnInvocationId: 'turn-inv',
        content: JSON.stringify({ type: 'provider_recovery', provider: 'codex', phase, attempts: ['disconnect'] }),
      }),
    );
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
    expect(mockPatchMessage).not.toHaveBeenCalled();
  });

  it('suppresses tool_activity telemetry on the active stream path', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'antig-opus',
        content: JSON.stringify({ type: 'tool_activity', toolName: 'view_file' }),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });

  it('suppresses mcp_server_status telemetry on the active stream path', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({
          type: 'mcp_server_status',
          provider: 'claude',
          pendingMeaning: 'deferred_tool_loading',
          counts: { connected: 1, pending: 1, failed: 0, disabled: 0, 'needs-auth': 0 },
          servers: [{ name: 'MCP_DOCKER', status: 'pending' }],
        }),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });

  it('renders a2a_pingpong_terminated JSON as readable system message', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'sonnet',
        content: JSON.stringify({
          type: 'a2a_pingpong_terminated',
          fromCatId: 'sonnet',
          targetCatId: 'gpt52',
          pairCount: 4,
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'info',
        content: '🏓 sonnet ↔ gpt52 已连续互相 @ 4 轮，链路已熔断。',
        extra: {
          systemInfo: {
            v: 1,
            payload: {
              type: 'a2a_pingpong_terminated',
              fromCatId: 'sonnet',
              targetCatId: 'gpt52',
              pairCount: 4,
            },
            fallbackCatId: 'sonnet',
          },
        },
      }),
    );
  });

  it('keeps provider capacity retries in execution detail, not chat', () => {
    act(() => root.render(React.createElement(Harness)));
    act(() =>
      captured?.handleAgentMessage({
        type: 'provider_signal',
        catId: 'antig-opus',
        content: JSON.stringify({
          type: 'warning',
          presentation: 'transient_status',
          message: 'capacity retry in 20s',
        }),
      }),
    );
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockUpdateThreadCatStatus).toHaveBeenCalledWith(
      'thread-1',
      'antig-opus',
      'spawning',
      'capacity retry in 20s',
    );
  });

  it('keeps unstructured provider signals in execution detail rather than chat', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'provider_signal',
        catId: 'antig-opus',
        content: 'raw upstream notice',
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockUpdateThreadCatStatus).toHaveBeenCalledWith('thread-1', 'antig-opus', 'spawning', 'raw upstream notice');
  });

  it('Bug-J: empty provider_signal payload is not surfaced (no ghost bubble)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    mockAddMessage.mockClear();
    act(() => {
      captured?.handleAgentMessage({
        type: 'provider_signal',
        catId: 'antig-opus',
        content: '',
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });
});
