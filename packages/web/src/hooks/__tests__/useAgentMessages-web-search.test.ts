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
const mockClearAllActiveInvocations = vi.fn(() => {
  mockSetHasActiveInvocation(false);
});
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockSetMessageUsage = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockSetMessageMetadata = vi.fn();
const mockSetMessageThinking = vi.fn();
const mockPatchMessage = vi.fn();

const mockAddMessageToThread = vi.fn((_threadId: string, message: (typeof storeState.messages)[number]) => {
  if (!storeState.messages.some((m) => m.id === message.id)) storeState.messages = [...storeState.messages, message];
});
const mockAppendToolEventToThread = vi.fn();
const mockPatchThreadMessage = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({ messages: storeState.messages }));

const storeState = {
  messages: [] as Array<{
    id: string;
    type: string;
    catId?: string;
    content: string;
    isStreaming?: boolean;
    timestamp: number;
    extra?: Record<string, unknown>;
  }>,
  addMessage: mockAddMessage,
  appendToMessage: mockAppendToMessage,
  appendToolEvent: mockAppendToolEvent,
  appendRichBlock: mockAppendRichBlock,
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
  setMessageMetadata: mockSetMessageMetadata,
  setMessageThinking: mockSetMessageThinking,
  patchMessage: mockPatchMessage,

  // Named-message writes (hooks/named-message-writer.ts) — thread-scoped
  addMessageToThread: mockAddMessageToThread,
  appendToThreadMessage: vi.fn(),
  patchThreadMessage: mockPatchThreadMessage,
  appendToolEventToThread: mockAppendToolEventToThread,
  setThreadMessageThinking: vi.fn(),
  appendRichBlockToThread: vi.fn(),
  setThreadMessageMetadata: vi.fn(),
  setThreadMessageUsage: vi.fn(),
  incrementUnread: vi.fn(),
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

describe('useAgentMessages system_info web_search', () => {
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
    mockAddMessage.mockReset();
    mockAddMessage.mockImplementation((message) => {
      storeState.messages = [...storeState.messages, message];
    });
    mockAppendToolEvent.mockClear();
    mockPatchMessage.mockClear();
    mockAddMessageToThread.mockClear();
    mockAppendToolEventToThread.mockClear();
    mockPatchThreadMessage.mockClear();
    mockClearAllActiveInvocations.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('consumes web_search JSON and appends a tool event to the named response (no raw JSON system bubble)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        content: 'hello',
        origin: 'stream',
        messageId: 'resp-1',
      });
    });

    // The first body event creates the response under its server id.
    expect(storeState.messages.filter((m) => m.type === 'assistant').map((m) => m.id)).toEqual(['resp-1']);

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        messageId: 'resp-1',
        content: JSON.stringify({ type: 'web_search', catId: 'codex', count: 1 }),
      });
    });

    expect(mockAppendToolEventToThread).toHaveBeenCalledWith(
      'thread-1',
      'resp-1',
      expect.objectContaining({
        type: 'tool_use',
        label: expect.stringContaining('web_search'),
      }),
    );

    const systemJsonCalls = mockAddMessage.mock.calls.filter(
      (call) => call[0]?.type === 'system' && String(call[0]?.content).includes('"web_search"'),
    );
    expect(systemJsonCalls).toHaveLength(0);
  });

  it('does not patch a newer same-cat bubble when an older supplement original is not loaded', () => {
    storeState.messages = [
      {
        id: 'msg-newer',
        type: 'assistant',
        catId: 'codex',
        content: 'newer unrelated answer',
        timestamp: 300,
      },
    ];
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({
          type: 'freshness_supplement',
          supplementId: 'f254-supplement:msg-older:1',
          lineageId: 'msg-older',
          originalMessageId: 'msg-older',
          threadId: 'thread-1',
          catId: 'codex',
          seq: 1,
          status: 'running',
          requiredCount: 1,
          updatedAt: 400,
        }),
      });
    });

    expect(mockPatchMessage).not.toHaveBeenCalled();
    expect(mockPatchThreadMessage).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system', content: expect.stringContaining('freshness_supplement') }),
    );
  });
});
