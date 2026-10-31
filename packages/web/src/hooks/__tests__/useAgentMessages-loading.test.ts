import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));

const mockAddMessage = vi.fn();
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
  setLoading: mockSetLoading,
  setHasActiveInvocation: mockSetHasActiveInvocation,
  removeActiveInvocation: mockRemoveActiveInvocation,
  clearAllActiveInvocations: mockClearAllActiveInvocations,
  setIntentMode: mockSetIntentMode,
  setCatStatus: mockSetCatStatus,
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  requestStreamCatchUp: mockRequestStreamCatchUp,
  catInvocations: {} as Record<string, { invocationId?: string; turnInvocationId?: string }>,

  addMessageToThread: mockAddMessageToThread,
  // named-message-writer: body events that name their message write through these thread-scoped members.
  appendToThreadMessage: vi.fn(),
  appendToolEventToThread: vi.fn(),
  setThreadMessageThinking: vi.fn(),
  appendRichBlockToThread: vi.fn(),
  setThreadMessageMetadata: vi.fn(),
  setThreadMessageUsage: vi.fn(),
  incrementUnread: vi.fn(),
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
    mockSetLoading.mockClear();
    mockSetHasActiveInvocation.mockClear();
    mockRemoveActiveInvocation.mockClear();
    mockClearAllActiveInvocations.mockClear();
    mockSetIntentMode.mockClear();
    mockSetCatStatus.mockClear();
    mockClearCatStatuses.mockClear();
    mockSetCatInvocation.mockClear();

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
        messageId: 'resp-1',
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

    // No messageId: a preflight/registration failure keeps its own error row.
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

  it('keeps handleAgentMessage stable when only messages change', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    const firstHandler = captured?.handleAgentMessage;
    expect(firstHandler).toBeTruthy();

    storeState.messages = [
      {
        id: 'resp-1',
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
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
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
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'opus',
      expect.objectContaining({
        compactBoundary: expect.objectContaining({ preTokens: 42000 }),
      }),
    );
  });
});
