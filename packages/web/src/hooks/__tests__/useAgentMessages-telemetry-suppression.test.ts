import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

const mockAddMessage = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockAppendRichBlock = vi.fn();
const mockSetStreaming = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn();
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

describe('useAgentMessages telemetry suppression', () => {
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

  it('suppresses strategy_allow_compress — no system bubble', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'strategy_allow_compress', allowCompress: true }),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('suppresses resume_failure_stats — no system bubble', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'resume_failure_stats', failures: 3, recovered: 2 }),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  // F230 P2 turn_duration: PTY carrier emits turn_duration as system_info terminal event.
  // It must be silently consumed — never surfaced as a raw JSON bubble.
  // Real observed bubble: {"type":"turn_duration","catId":"sonnet","durationMs":9488,"messageCount":38}
  it('suppresses turn_duration — no system bubble (F230 P2)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'sonnet',
        content: JSON.stringify({ type: 'turn_duration', catId: 'sonnet', durationMs: 9488, messageCount: 38 }),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: 'context_presentation_receipt',
      v: 1,
      outcome: 'presented',
      invocationId: 'inv-receipt',
      generationId: 'sha256:receipt',
      projectionIds: ['cue-1'],
    },
    {
      type: 'context_continuity',
      v: 1,
      invocationId: 'inv-continuity',
      contextEpoch: 1,
      contextMode: 'cold',
      transition: 'scope_first_seen',
    },
    {
      type: 'future_internal_protocol_event',
      v: 1,
      internalCoordinate: 'must-not-render-raw',
    },
  ])('fails closed for unprojected structured protocol $type', (payload) => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        content: JSON.stringify(payload),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('fails closed when a recognized internal projector throws', () => {
    mockSetCatInvocation.mockImplementationOnce(() => {
      throw new Error('simulated context-health projection failure');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    act(() => {
      root.render(React.createElement(Harness));
    });

    try {
      act(() => {
        captured?.handleAgentMessage({
          type: 'system_info',
          catId: 'codex-sol',
          content: JSON.stringify({
            type: 'context_health',
            health: { usedTokens: 42, windowTokens: 200000 },
          }),
        });
      });
    } finally {
      warnSpy.mockRestore();
    }

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('keeps plain-text system notices visible', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'system',
        content: '服务连接已恢复',
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '服务连接已恢复' }));
  });
});
