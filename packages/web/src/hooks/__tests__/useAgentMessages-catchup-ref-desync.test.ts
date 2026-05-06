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

type TestMessage = {
  id: string;
  type: string;
  catId?: string;
  content: string;
  isStreaming?: boolean;
  origin?: string;
  extra?: { stream?: { invocationId?: string } };
  timestamp: number;
};

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
const threadMessages = new Map<string, TestMessage[]>();
// F183 B1.2.2: active text stream → reducer → replaceMessages
const mockReplaceMessages = vi.fn((msgs: unknown[]) => {
  storeState.messages = msgs as typeof storeState.messages;
});

const mockAddMessageToThread = vi.fn((threadId: string, message: TestMessage) => {
  threadMessages.set(threadId, [...(threadMessages.get(threadId) ?? []), message]);
});
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn((threadId: string, messageId: string, streaming: boolean) => {
  threadMessages.set(
    threadId,
    (threadMessages.get(threadId) ?? []).map((message) =>
      message.id === messageId ? { ...message, isStreaming: streaming } : message,
    ),
  );
});
const mockReplaceThreadMessages = vi.fn((threadId: string, messages: TestMessage[]) => {
  threadMessages.set(threadId, messages);
});
const mockReplaceThreadMessageId = vi.fn((threadId: string, oldId: string, newId: string) => {
  threadMessages.set(
    threadId,
    (threadMessages.get(threadId) ?? []).map((message) => (message.id === oldId ? { ...message, id: newId } : message)),
  );
});
const mockPatchThreadMessage = vi.fn((threadId: string, messageId: string, patch: Partial<TestMessage>) => {
  threadMessages.set(
    threadId,
    (threadMessages.get(threadId) ?? []).map((message) =>
      message.id === messageId ? { ...message, ...patch } : message,
    ),
  );
});
const mockBatchStreamChunkUpdate = vi.fn(
  ({
    threadId,
    messageId,
    content,
    streaming,
  }: {
    threadId: string;
    messageId: string;
    content?: string;
    streaming?: boolean;
  }) => {
    threadMessages.set(
      threadId,
      (threadMessages.get(threadId) ?? []).map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: `${message.content}${content ?? ''}`,
              ...(streaming === undefined ? {} : { isStreaming: streaming }),
            }
          : message,
      ),
    );
  },
);
const mockUpdateThreadCatStatus = vi.fn();
const mockSetThreadCatInvocation = vi.fn();
const mockSetThreadLoading = vi.fn();
const mockSetThreadHasActiveInvocation = vi.fn();
const mockAddThreadActiveInvocation = vi.fn();
const mockRemoveThreadActiveInvocation = vi.fn();
const mockGetThreadState = vi.fn((threadId: string) => ({
  messages: threadMessages.get(threadId) ?? [],
  hasMore: true,
  isLoading: false,
  hasActiveInvocation: false,
  catStatuses: {},
  catInvocations: {},
  activeInvocations: {},
}));

const storeState = {
  messages: [] as TestMessage[],
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
  replaceMessages: mockReplaceMessages,
  replaceThreadMessages: mockReplaceThreadMessages,
  replaceThreadMessageId: mockReplaceThreadMessageId,
  patchThreadMessage: mockPatchThreadMessage,
  batchStreamChunkUpdate: mockBatchStreamChunkUpdate,
  updateThreadCatStatus: mockUpdateThreadCatStatus,
  setThreadCatInvocation: mockSetThreadCatInvocation,
  setThreadLoading: mockSetThreadLoading,
  setThreadHasActiveInvocation: mockSetThreadHasActiveInvocation,
  addThreadActiveInvocation: mockAddThreadActiveInvocation,
  removeThreadActiveInvocation: mockRemoveThreadActiveInvocation,
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
    threadMessages.clear();
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

    // Should create a fresh bubble via addMessage OR replaceMessages (F183 B1.2.3)
    const addedFresh = mockAddMessage.mock.calls.some(
      ([m]) => m.type === 'assistant' && m.catId === 'opus' && m.content === 'New response' && m.origin === 'stream',
    );
    const replacedFresh = mockReplaceMessages.mock.calls.some((c) =>
      (c[0] as Array<{ type?: string; catId?: string; content?: string; origin?: string }>).some(
        (m) => m.type === 'assistant' && m.catId === 'opus' && m.content === 'New response' && m.origin === 'stream',
      ),
    );
    expect(addedFresh || replacedFresh, 'fresh bubble must be created via addMessage or replaceMessages').toBe(true);
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

  it('defers callback replacement until done so later stream chunks are not suppressed', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-race',
        origin: 'stream',
        content: 'stream head',
      });
    });

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'msg-inv-race-opus',
        catId: 'opus',
        origin: 'stream',
        content: 'stream head',
        isStreaming: true,
      }),
    ]);

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-race',
        origin: 'callback',
        content: 'authoritative callback',
        messageId: 'callback-race-final',
      });
    });

    // Callback arrived early while the invocation is still active. It must not
    // immediately mark the invocation as replaced; otherwise the next stream
    // tail gets suppressed and live output diverges until F5/catch-up.
    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'msg-inv-race-opus',
        origin: 'stream',
        content: 'stream head',
        isStreaming: true,
      }),
    ]);

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-race',
        origin: 'stream',
        content: ' + late stream tail',
      });
    });

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'msg-inv-race-opus',
        origin: 'stream',
        content: 'stream head + late stream tail',
        isStreaming: true,
      }),
    ]);

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-race',
        isFinal: true,
      });
    });

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'callback-race-final',
        catId: 'opus',
        origin: 'callback',
        content: 'authoritative callback',
        isStreaming: false,
      }),
    ]);
  });

  it('drains deferred callback on active text-final terminal event', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-text-final',
        origin: 'stream',
        content: 'stream head',
      });
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-text-final',
        origin: 'callback',
        content: 'authoritative callback after text final',
        messageId: 'callback-text-final',
      });
    });

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'msg-inv-text-final-opus',
        origin: 'stream',
        content: 'stream head',
        isStreaming: true,
      }),
    ]);

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-text-final',
        origin: 'stream',
        content: ' terminal stream tail',
        isFinal: true,
      });
    });

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'callback-text-final',
        catId: 'opus',
        origin: 'callback',
        content: 'authoritative callback after text final',
        isStreaming: false,
      }),
    ]);
  });

  it('drains deferred callback on active text-final terminal event without extra content', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-text-final-empty',
        origin: 'stream',
        content: 'stream head',
      });
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-text-final-empty',
        origin: 'callback',
        content: 'authoritative callback after empty text final',
        messageId: 'callback-text-final-empty',
      });
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-1',
        catId: 'opus',
        invocationId: 'inv-text-final-empty',
        origin: 'stream',
        content: '',
        isFinal: true,
      });
    });

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'callback-text-final-empty',
        catId: 'opus',
        origin: 'callback',
        content: 'authoritative callback after empty text final',
        isStreaming: false,
      }),
    ]);
  });

  it('drains deferred callback on timeout when terminal done is missing', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-timeout',
          origin: 'stream',
          content: 'stale stream text',
        });
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-timeout',
          origin: 'callback',
          content: 'authoritative callback after missing done',
          messageId: 'callback-timeout-final',
        });
      });

      expect(storeState.messages).toEqual([
        expect.objectContaining({
          id: 'msg-inv-timeout-opus',
          origin: 'stream',
          content: 'stale stream text',
          isStreaming: true,
        }),
      ]);

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(storeState.messages).toEqual([
        expect.objectContaining({
          id: 'callback-timeout-final',
          catId: 'opus',
          origin: 'callback',
          content: 'authoritative callback after missing done',
          isStreaming: false,
        }),
      ]);
      expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains deferred background callback on fallback timeout when terminal event is missing', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-bg',
          catId: 'opus',
          invocationId: 'inv-bg-timeout',
          origin: 'stream',
          content: 'background stream head',
        });
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-bg',
          catId: 'opus',
          invocationId: 'inv-bg-timeout',
          origin: 'callback',
          content: 'authoritative background callback after missing terminal',
          messageId: 'bg-callback-timeout-final',
        });
      });

      expect(threadMessages.get('thread-bg')).toEqual([
        expect.objectContaining({
          id: 'msg-inv-bg-timeout-opus',
          origin: 'stream',
          content: 'background stream head',
          isStreaming: true,
        }),
      ]);

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(threadMessages.get('thread-bg')).toEqual([
        expect.objectContaining({
          id: 'bg-callback-timeout-final',
          catId: 'opus',
          origin: 'callback',
          content: 'authoritative background callback after missing terminal',
          isStreaming: false,
        }),
      ]);
      expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-bg');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears deferred callback when a stale invocation emits terminal error', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-stale-error',
          origin: 'stream',
          content: 'stale stream text',
        });
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-stale-error',
          origin: 'callback',
          content: 'stale callback must not replay',
          messageId: 'callback-stale-error',
        });
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-fresh-error',
          origin: 'stream',
          content: 'fresh stream text',
        });
      });

      // A newer invocation has taken the cat's active slot, so the old error is
      // stale and must not mutate the live bubble. It still owns the old pending
      // callback entry, and a terminal error is the last chance to invalidate it.
      storeState.activeInvocations = { 'inv-fresh-error': { catId: 'opus', mode: 'execute' } };
      storeState.catInvocations = { opus: { invocationId: 'inv-fresh-error' } };

      act(() => {
        captured?.handleAgentMessage({
          type: 'error',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-stale-error',
          error: 'stale invocation failed',
          isFinal: true,
        });
      });

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(storeState.messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'callback-stale-error',
            content: 'stale callback must not replay',
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears deferred callback when a stale invocation emits terminal done', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-stale-done',
          origin: 'stream',
          content: 'stale stream text',
        });
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-stale-done',
          origin: 'callback',
          content: 'stale done callback must not replay',
          messageId: 'callback-stale-done',
        });
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-fresh-done',
          origin: 'stream',
          content: 'fresh stream text',
        });
      });

      // The old done is stale for UI state, but still terminal for its own
      // invocation. It must invalidate the old deferred callback entry.
      storeState.activeInvocations = { 'inv-fresh-done': { catId: 'opus', mode: 'execute' } };
      storeState.catInvocations = { opus: { invocationId: 'inv-fresh-done' } };

      act(() => {
        captured?.handleAgentMessage({
          type: 'done',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-stale-done',
          isFinal: true,
        });
      });

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(storeState.messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'callback-stale-done',
            content: 'stale done callback must not replay',
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears deferred callback when the user stops the invocation', () => {
    vi.useFakeTimers();
    try {
      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-stopped',
          origin: 'stream',
          content: 'stopped stream text',
        });
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-stopped',
          origin: 'callback',
          content: 'stopped callback must not replay',
          messageId: 'callback-stopped',
        });
      });

      act(() => {
        captured?.handleStop(vi.fn(), 'thread-1');
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          threadId: 'thread-1',
          catId: 'opus',
          invocationId: 'inv-after-stop',
          origin: 'stream',
          content: 'new stream text',
        });
      });

      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });

      expect(storeState.messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'callback-stopped',
            content: 'stopped callback must not replay',
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetRefs keeps deferred callbacks for background threads', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-bg',
        catId: 'opus',
        invocationId: 'inv-bg-reset',
        origin: 'stream',
        content: 'background stream head',
      });
    });

    expect(threadMessages.get('thread-bg')).toEqual([
      expect.objectContaining({
        id: 'msg-inv-bg-reset-opus',
        origin: 'stream',
        content: 'background stream head',
        isStreaming: true,
      }),
    ]);

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-bg',
        catId: 'opus',
        invocationId: 'inv-bg-reset',
        origin: 'callback',
        content: 'authoritative background callback',
        messageId: 'bg-callback-reset',
      });
    });

    // Active-thread reset must not erase a deferred callback owned by a
    // background thread. The callback should still drain when that bg invocation
    // later reaches done.
    act(() => {
      captured?.resetRefs();
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        threadId: 'thread-bg',
        catId: 'opus',
        invocationId: 'inv-bg-reset',
        isFinal: true,
      });
    });

    expect(threadMessages.get('thread-bg')).toEqual([
      expect.objectContaining({
        id: 'bg-callback-reset',
        origin: 'callback',
        content: 'authoritative background callback',
        isStreaming: false,
      }),
    ]);
  });

  it('resetRefs keeps deferred callbacks when thread switch makes that thread current first', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-bg',
        catId: 'opus',
        invocationId: 'inv-bg-current-reset',
        origin: 'stream',
        content: 'background stream before switch',
      });
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        threadId: 'thread-bg',
        catId: 'opus',
        invocationId: 'inv-bg-current-reset',
        origin: 'callback',
        content: 'authoritative callback after switch',
        messageId: 'bg-callback-current-reset',
      });
    });

    // ChatContainer calls setCurrentThread(threadId) before resetRefs().
    // setCurrentThread restores the target thread's threadState into the flat
    // active messages before resetRefs runs; mirror that real store behavior so
    // the terminal done drains through the active path after navigation.
    storeState.currentThreadId = 'thread-bg';
    storeState.messages = threadMessages.get('thread-bg') ?? [];
    act(() => {
      captured?.resetRefs();
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        threadId: 'thread-bg',
        catId: 'opus',
        invocationId: 'inv-bg-current-reset',
        isFinal: true,
      });
    });

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'bg-callback-current-reset',
        origin: 'callback',
        content: 'authoritative callback after switch',
        isStreaming: false,
      }),
    ]);
  });
});
