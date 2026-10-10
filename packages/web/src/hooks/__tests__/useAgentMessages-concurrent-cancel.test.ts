/**
 * F108 P1: Cancelling one cat during concurrent execution must NOT clear other cats' state.
 *
 * Root cause: done(isFinal) handler unconditionally calls setIntentMode(null),
 * clearCatStatuses(), setLoading(false) — even when other cats are still active.
 *
 * Fix: only clear global state when the LAST active invocation ends.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

interface TestMessage {
  id: string;
  type: string;
  catId?: string;
  content: string;
  variant?: string;
  origin?: string;
  isStreaming?: boolean;
  timestamp: number;
  lifecycle?: Record<string, unknown>;
}

const mockAddMessage = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockSetStreaming = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockClearAllActiveInvocations = vi.fn();
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockSetMessageUsage = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockRemoveActiveInvocation = vi.fn();

// Thread-scoped writes are stateful for the open thread, mirroring the real store
// (the open thread's messages ARE the root `messages`).
function currentMessages(): TestMessage[] {
  return storeState.messages as TestMessage[];
}

function patchCurrentMessage(threadId: string, messageId: string, patch: Partial<TestMessage>) {
  if (threadId !== storeState.currentThreadId) return;
  storeState.messages = currentMessages().map((m) => (m.id === messageId ? { ...m, ...patch } : m));
}

const mockAddMessageToThread = vi.fn((threadId: string, message: TestMessage) => {
  if (threadId !== storeState.currentThreadId || currentMessages().some((m) => m.id === message.id)) return;
  storeState.messages = [...currentMessages(), message];
});
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn((threadId: string, messageId: string, streaming: boolean) =>
  patchCurrentMessage(threadId, messageId, { isStreaming: streaming }),
);
const mockGetThreadState = vi.fn((threadId: string) => ({
  messages: threadId === storeState.currentThreadId ? currentMessages() : [],
}));

const storeState: Record<string, unknown> = {
  messages: [] as TestMessage[],
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
  removeActiveInvocation: mockRemoveActiveInvocation,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-1',
  // Named-message writes (hooks/named-message-writer.ts) — thread-scoped
  appendToThreadMessage: vi.fn(),
  patchThreadMessage: vi.fn(patchCurrentMessage),
  appendToolEventToThread: vi.fn(),
  setThreadMessageThinking: vi.fn(),
  appendRichBlockToThread: vi.fn(),
  setThreadMessageMetadata: vi.fn(),
  setThreadMessageUsage: vi.fn(),
  incrementUnread: vi.fn(),

  // F108: Two cats actively running
  activeInvocations: {
    'inv-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
    'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
  },
  catInvocations: {},
};

/** The turn's response as the server stores it at dispatch: empty, processing, real id. */
function seedResponse(id: string, catId: string, invocationId: string) {
  const response: TestMessage = {
    id,
    type: 'assistant',
    catId,
    content: '',
    origin: 'stream',
    isStreaming: true,
    timestamp: 1000,
    lifecycle: {
      kind: 'response',
      orderKey: `1000:${invocationId}`,
      invocationId,
      targetId: catId,
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 1000,
    },
  };
  storeState.messages = [...currentMessages(), response];
}

/** System rows added through either the flat or the thread-scoped path. */
function systemRows(): TestMessage[] {
  const flat = mockAddMessage.mock.calls.map((call) => call[0] as TestMessage);
  return [...flat, ...currentMessages()].filter((m) => m.type === 'system');
}

let captured: ReturnType<typeof useAgentMessages> | undefined;

vi.mock('@/stores/chatStore', () => {
  const useChatStoreMock = Object.assign(() => storeState, { getState: () => storeState });
  return { useChatStore: useChatStoreMock };
});

function Harness() {
  captured = useAgentMessages();
  return null;
}

describe('F108 P1: concurrent cancel isolation', () => {
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

    // Reset two-cat concurrent state
    storeState.activeInvocations = {
      'inv-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
    };
    storeState.catInvocations = {};
    storeState.messages = [];
    storeState.currentThreadId = 'thread-1';

    // Make removeActiveInvocation actually remove from the record
    mockRemoveActiveInvocation.mockImplementation((invId: string) => {
      const inv = storeState.activeInvocations as Record<string, unknown>;
      delete inv[invId];
    });

    for (const fn of [
      mockAddMessage,
      mockAppendToMessage,
      mockAppendToolEvent,
      mockSetStreaming,
      mockSetLoading,
      mockSetHasActiveInvocation,
      mockClearAllActiveInvocations,
      mockSetIntentMode,
      mockSetCatStatus,
      mockClearCatStatuses,
      mockSetCatInvocation,
      mockSetMessageUsage,
      mockRemoveActiveInvocation,
      mockRequestStreamCatchUp,
      mockAddMessageToThread,
      mockClearThreadActiveInvocation,
      mockResetThreadInvocationState,
      mockSetThreadMessageStreaming,
      mockGetThreadState,
    ]) {
      fn.mockClear();
    }
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('done(isFinal) for one cat does NOT clear global state when another cat is still active', () => {
    act(() => root.render(React.createElement(Harness)));

    // Cancel codex — opus is still running
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        messageId: 'resp-codex',
        isFinal: true,
      });
    });

    // Global state should NOT be cleared — opus is still active
    expect(mockSetIntentMode).not.toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).not.toHaveBeenCalled();
    // setLoading(false) should not be called while another cat runs
    expect(mockSetLoading).not.toHaveBeenCalledWith(false);
  });

  it('done(isFinal) for the LAST cat DOES clear global state', () => {
    // Only one cat active
    storeState.activeInvocations = {
      'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
    };

    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        messageId: 'resp-codex',
        isFinal: true,
      });
    });

    // Now global state SHOULD be cleared — no more active cats
    expect(mockSetIntentMode).toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).toHaveBeenCalled();
    expect(mockSetLoading).toHaveBeenCalledWith(false);
  });

  it('error(isFinal) for one cat does NOT clear global state when another cat is still active', () => {
    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'error',
        catId: 'codex',
        messageId: 'resp-codex',
        error: 'something broke',
        isFinal: true,
      });
    });

    // Global state should NOT be cleared — opus is still active
    expect(mockSetIntentMode).not.toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).not.toHaveBeenCalled();
  });

  it('error(isFinal) for the LAST cat DOES clear global state (including clearCatStatuses)', () => {
    // Only one cat active
    storeState.activeInvocations = {
      'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
    };
    seedResponse('resp-codex', 'codex', 'inv-codex');

    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'error',
        catId: 'codex',
        messageId: 'resp-codex',
        error: 'something broke',
        isFinal: true,
      });
    });

    // Now global state SHOULD be cleared — no more active cats
    expect(mockSetIntentMode).toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).toHaveBeenCalled();
    expect(mockSetLoading).toHaveBeenCalledWith(false);
    // The error names the turn's response: R carries the failure itself (no error row)
    // and stops streaming.
    expect(systemRows()).toEqual([]);
    expect(currentMessages().find((m) => m.id === 'resp-codex')).toMatchObject({ isStreaming: false });
  });

  it('recoverable non-final error keeps the invocation cancelable and its response streaming', () => {
    storeState.activeInvocations = {
      'inv-antig': { catId: 'antig-opus', mode: 'execute', startedAt: Date.now() },
    };
    seedResponse('resp-antig', 'antig-opus', 'inv-antig');

    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'error',
        catId: 'antig-opus',
        invocationId: 'inv-antig',
        messageId: 'resp-antig',
        error: 'The model produced an invalid tool call.',
        errorCode: 'upstream_error',
        isFinal: false,
      });
    });

    // The error names the turn's response, so no error row; being recoverable and
    // in flight, it must not stop R streaming or tear the invocation down.
    expect(systemRows()).toEqual([]);
    expect(currentMessages().find((m) => m.id === 'resp-antig')).toMatchObject({ isStreaming: true });
    expect(mockSetCatStatus).not.toHaveBeenCalledWith('antig-opus', 'error');
    expect(mockRemoveActiveInvocation).not.toHaveBeenCalled();
    expect(storeState.activeInvocations).toEqual({
      'inv-antig': { catId: 'antig-opus', mode: 'execute', startedAt: expect.any(Number) },
    });
  });
});
