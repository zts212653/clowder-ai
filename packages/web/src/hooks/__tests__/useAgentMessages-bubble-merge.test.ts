import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

const mockAddMessage = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockAppendRichBlock = vi.fn();
const mockSetStreaming = vi.fn((id: string, streaming: boolean) => {
  storeState.messages = storeState.messages.map((m) => (m.id === id ? { ...m, isStreaming: streaming } : m));
});
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn((catId: string, info: Record<string, unknown>) => {
  storeState.catInvocations = {
    ...storeState.catInvocations,
    [catId]: { ...storeState.catInvocations[catId], ...info },
  };
});
const mockSetMessageUsage = vi.fn();
const mockSetMessageMetadata = vi.fn();
const mockSetMessageThinking = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockReplaceMessageId = vi.fn();
const mockPatchMessage = vi.fn();

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
    origin?: string;
    extra?: { stream?: { invocationId?: string } };
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
  replaceMessageId: mockReplaceMessageId,
  patchMessage: mockPatchMessage,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-1',
  catInvocations: {} as Record<string, { invocationId?: string }>,
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

describe('useAgentMessages bubble merge prevention (Bug B)', () => {
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
    storeState.catInvocations = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('done event clears invocationId to prevent stale recovery of finalized messages', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Setup: invocation 1 created a streaming message
    const msgA = {
      id: 'msg-A',
      type: 'assistant',
      catId: 'opus',
      content: 'Response A',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: Date.now() - 2000,
    };
    storeState.messages.push(msgA);
    storeState.catInvocations = { opus: { invocationId: 'inv-1' } };

    // Invocation 1 sends text
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'Response A',
      });
    });

    // Invocation 1 completes — done event arrives
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        isFinal: true,
      });
    });

    // After done: message A should be finalized (isStreaming: false)
    // The key assertion: setCatInvocation should have been called to clear invocationId
    // so that findRecoverableAssistantMessage can't match the old message
    const clearCalls = mockSetCatInvocation.mock.calls.filter(
      ([catId, info]) => catId === 'opus' && info.invocationId === undefined,
    );
    expect(clearCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('callback with invocationId falls back to invocationless placeholder when strict match fails', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Setup: an invocationless stream bubble exists (invocation_created was lost)
    const placeholderMsg = {
      id: 'msg-placeholder',
      type: 'assistant',
      catId: 'opus',
      content: 'streaming...',
      isStreaming: true,
      origin: 'stream',
      // No invocationId — this is the invocationless placeholder
      extra: { stream: {} },
      timestamp: Date.now() - 1000,
    };
    storeState.messages.push(placeholderMsg);

    // Simulate text arriving (so activeRefs gets set for this cat)
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'streaming...',
      });
    });

    vi.clearAllMocks();

    // Callback arrives WITH invocationId, but no bubble has that invocationId tagged
    // (because invocation_created was lost during micro-disconnect)
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        origin: 'callback',
        content: 'Final callback response',
        invocationId: 'inv-lost',
        messageId: 'msg-final',
      });
    });

    // With cascade: should fall back to invocationless placeholder and patch it
    // NOT create a brand new standalone bubble
    const newBubbleCalls = mockAddMessage.mock.calls.filter(
      ([msg]) => msg.type === 'assistant' && msg.catId === 'opus',
    );
    expect(newBubbleCalls).toHaveLength(0);
  });

  it('new invocation text does not append to previous finalized message', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Invocation 1: streaming message A
    storeState.messages.push({
      id: 'msg-A',
      type: 'assistant',
      catId: 'opus',
      content: 'Response A',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: Date.now() - 2000,
    });
    storeState.catInvocations = { opus: { invocationId: 'inv-1' } };

    // Invocation 1: stream text
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'Response A',
      });
    });

    // Invocation 1 completes — done event finalizes the message
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        isFinal: true,
      });
    });

    // After done: invocationId should be cleared (by the fix)
    // Message A should have isStreaming: false
    vi.clearAllMocks();

    // New invocation 2: first text arrives (invocation_created may or may not have arrived)
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'Response D',
      });
    });

    // Bug B assertion: should NOT append to msg-A (finalized message)
    const appendToACalls = mockAppendToMessage.mock.calls.filter(([id]) => id === 'msg-A');
    expect(appendToACalls).toHaveLength(0);

    // Should have created a new message for the new invocation
    const newAssistantCalls = mockAddMessage.mock.calls.filter(
      ([msg]) => msg.type === 'assistant' && msg.catId === 'opus',
    );
    expect(newAssistantCalls.length).toBeGreaterThanOrEqual(1);
  });
});
