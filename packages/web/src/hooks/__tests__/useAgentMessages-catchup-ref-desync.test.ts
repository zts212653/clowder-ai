/**
 * Regression test for #266 Round 2: socket reconnect eager catch-up replaced
 * store messages while stream was still active, causing Zustand store / useRef
 * desync → duplicate bubbles.
 *
 * Fix: removed the eager requestStreamCatchUp on reconnect (useSocket.ts) and
 * enhanced resetRefs to clear ALL ref maps (not just activeRefs + replacedInvocationsRef).
 *
 * This test verifies the resetRefs enhancement: after calling resetRefs(), the
 * hook must NOT try to recover or append to the old bubble from a prior invocation.
 *
 * Intake source: clowder-ai#378 (selective absorb — resetRefs patch only)
 */
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
const mockSetMessageStreamInvocation = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockReplaceMessageId = vi.fn();
const mockPatchMessage = vi.fn();
const mockRemoveMessage = vi.fn();
const mockRemoveActiveInvocation = vi.fn();
const mockClearAllActiveInvocations = vi.fn();

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
  setMessageStreamInvocation: mockSetMessageStreamInvocation,
  replaceMessageId: mockReplaceMessageId,
  patchMessage: mockPatchMessage,
  removeMessage: mockRemoveMessage,
  removeActiveInvocation: mockRemoveActiveInvocation,
  clearAllActiveInvocations: mockClearAllActiveInvocations,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-1',
  catInvocations: {} as Record<string, { invocationId?: string }>,
  activeInvocations: {} as Record<string, unknown>,
};

let captured: ReturnType<typeof useAgentMessages> | undefined;

vi.mock('@/stores/chatStore', () => {
  const useChatStoreMock = Object.assign(() => storeState, { getState: () => storeState });
  return { useChatStore: useChatStoreMock };
});

function Harness() {
  captured = useAgentMessages();
  return null;
}

describe('useAgentMessages catch-up ref desync (#266 Round 2)', () => {
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
    storeState.activeInvocations = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('resetRefs clears all ref maps so stale IDs from prior invocation are forgotten', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Step 1: Create active stream → activeRefs + sawStreamDataRef populated
    storeState.catInvocations = { opus: { invocationId: 'inv-1' } };
    storeState.messages.push({
      id: 'msg-1-opus',
      type: 'assistant',
      catId: 'opus',
      content: 'Thinking...',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: Date.now(),
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'Thinking...',
      });
    });

    // Verify append went to original bubble
    expect(mockAppendToMessage).toHaveBeenCalledWith('msg-1-opus', 'Thinking...');

    // Step 2: done → finalizedStreamRef populated
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        isFinal: true,
      });
    });

    // Step 3: resetRefs (simulates what thread switch or catch-up cleanup would do)
    act(() => {
      captured?.resetRefs();
    });

    vi.clearAllMocks();

    // Step 4: Wipe store messages (simulates fetchHistory replace) + start new invocation
    storeState.messages = [];
    storeState.catInvocations = { opus: { invocationId: 'inv-2' } };

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'New response',
      });
    });

    // Key assertion: should NOT try to append to the dead 'msg-1-opus'
    const staleAppends = mockAppendToMessage.mock.calls.filter(([id]) => id === 'msg-1-opus');
    expect(staleAppends).toHaveLength(0);

    // Should create a fresh bubble via addMessage
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        catId: 'opus',
        content: 'New response',
        origin: 'stream',
      }),
    );
  });

  it('after resetRefs, callback does not merge into finalized stream from prior invocation', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Step 1: Stream + done → finalizedStreamRef set
    storeState.catInvocations = { opus: { invocationId: 'inv-1' } };
    storeState.messages.push({
      id: 'msg-stream',
      type: 'assistant',
      catId: 'opus',
      content: 'Stream content',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: Date.now(),
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'Stream content',
      });
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        isFinal: true,
      });
    });

    // Step 2: resetRefs clears finalizedStreamRef
    act(() => {
      captured?.resetRefs();
    });

    vi.clearAllMocks();

    // Step 3: A callback arrives for a NEW invocation.
    // IMPORTANT: old message stays in store (simulates fetchHistory keeping it).
    // If finalizedStreamRef is NOT cleared, findInvocationlessStreamPlaceholder
    // will find msg-stream via the stale ref and patch it instead of creating new.
    storeState.messages[0] = { ...storeState.messages[0], isStreaming: false };
    storeState.catInvocations = {};

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        origin: 'callback',
        content: 'New callback',
        messageId: 'backend-msg-new',
      });
    });

    // Key assertion: patchMessage should NOT have been called on old msg-stream
    const patchToOld = mockPatchMessage.mock.calls.filter(([id]) => id === 'msg-stream');
    expect(patchToOld).toHaveLength(0);

    // Should create standalone callback bubble
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'backend-msg-new',
        type: 'assistant',
        catId: 'opus',
        content: 'New callback',
        origin: 'callback',
      }),
    );
  });
});
