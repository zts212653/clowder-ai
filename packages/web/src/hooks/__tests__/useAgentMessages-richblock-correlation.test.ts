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
const mockReplaceMessageId = vi.fn((fromId: string, toId: string) => {
  storeState.messages = storeState.messages.map((m) => (m.id === fromId ? { ...m, id: toId } : m));
});
const mockPatchMessage = vi.fn((id: string, patch: Record<string, unknown>) => {
  storeState.messages = storeState.messages.map((m) => {
    if (m.id !== id) return m;
    const next = { ...m, ...patch } as typeof m & { metadata?: Record<string, unknown> };
    if ('extra' in patch && patch.extra && typeof patch.extra === 'object') {
      next.extra = { ...m.extra, ...(patch.extra as typeof m.extra) };
    }
    if ('metadata' in patch && patch.metadata && typeof patch.metadata === 'object') {
      next.metadata = { ...(m as { metadata?: Record<string, unknown> }).metadata, ...(patch.metadata as object) };
    }
    return next;
  });
});

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
    extra?: { rich?: { v: 1; blocks: Array<{ id: string }> }; stream?: { invocationId?: string } };
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

describe('useAgentMessages rich_block correlation (Bug A)', () => {
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

  it('appends rich_block (no messageId) to most recent callback message, not streaming message', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Simulate: a streaming message exists (cat is responding)
    const streamMsgId = 'msg-stream-opus';
    storeState.messages.push({
      id: streamMsgId,
      type: 'assistant',
      catId: 'opus',
      content: 'I am streaming...',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: Date.now() - 1000,
    });
    storeState.catInvocations = { opus: { invocationId: 'inv-1' } };

    // Simulate: callback text message arrives (post_message)
    const callbackMsgId = 'msg-callback-opus';
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'Here are your options:',
        origin: 'callback',
        messageId: callbackMsgId,
      });
    });

    // The callback message should be in the store now
    storeState.messages.push({
      id: callbackMsgId,
      type: 'assistant',
      catId: 'opus',
      content: 'Here are your options:',
      origin: 'callback',
      timestamp: Date.now(),
    });

    // Simulate: rich_block arrives WITHOUT messageId (create_rich_block callback path)
    const testBlock = { id: 'block-1', kind: 'interactive', v: 1, interactiveType: 'select', options: [] };
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'rich_block', block: testBlock }),
      });
    });

    // Bug A assertion: appendRichBlock should target the callback message, NOT the streaming message
    expect(mockAppendRichBlock).toHaveBeenCalledTimes(1);
    const [targetId, block] = mockAppendRichBlock.mock.calls[0];
    expect(targetId).toBe(callbackMsgId);
    expect(block.id).toBe('block-1');
    // Should NOT be attached to the streaming message
    expect(targetId).not.toBe(streamMsgId);
  });

  it('replaces an overlapping stream bubble with callback text from the same invocation', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    storeState.messages.push({
      id: 'msg-stream-opus',
      type: 'assistant',
      catId: 'opus',
      content: 'thinking...',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: Date.now() - 1000,
    });
    storeState.catInvocations = { opus: { invocationId: 'inv-1' } };

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'final answer',
        origin: 'callback',
        messageId: 'msg-callback-opus',
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockReplaceMessageId).toHaveBeenCalledWith('msg-stream-opus', 'msg-callback-opus');
    expect(mockPatchMessage).toHaveBeenCalledWith(
      'msg-callback-opus',
      expect.objectContaining({
        content: 'final answer',
        origin: 'callback',
        isStreaming: false,
      }),
    );

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'msg-callback-opus',
        catId: 'opus',
        content: 'final answer',
        origin: 'callback',
        isStreaming: false,
        extra: { stream: { invocationId: 'inv-1' } },
      }),
    ]);
  });

  it('replaces a finalized stream bubble when callback text arrives late for the same invocation', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    storeState.messages.push({
      id: 'msg-stream-finalized',
      type: 'assistant',
      catId: 'opus',
      content: 'thinking...',
      isStreaming: false,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-2' } },
      timestamp: Date.now() - 1000,
    });
    storeState.catInvocations = { opus: { invocationId: 'inv-2' } };

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'final answer',
        origin: 'callback',
        messageId: 'msg-callback-final',
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockReplaceMessageId).toHaveBeenCalledWith('msg-stream-finalized', 'msg-callback-final');
    expect(mockPatchMessage).toHaveBeenCalledWith(
      'msg-callback-final',
      expect.objectContaining({
        content: 'final answer',
        origin: 'callback',
        isStreaming: false,
      }),
    );
    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'msg-callback-final',
        catId: 'opus',
        content: 'final answer',
        origin: 'callback',
        isStreaming: false,
        extra: { stream: { invocationId: 'inv-2' } },
      }),
    ]);
  });

  it('drops late stream chunks after callback replacement instead of recreating a bubble', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    storeState.messages.push({
      id: 'msg-stream-opus',
      type: 'assistant',
      catId: 'opus',
      content: 'thinking...',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-3' } },
      timestamp: Date.now() - 1000,
    });
    storeState.catInvocations = { opus: { invocationId: 'inv-3' } };

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'final answer',
        origin: 'callback',
        messageId: 'msg-callback-opus',
      });
    });

    vi.clearAllMocks();

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: ' late chunk',
        origin: 'stream',
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAppendToMessage).not.toHaveBeenCalled();
    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'msg-callback-opus',
        catId: 'opus',
        content: 'final answer',
        origin: 'callback',
        isStreaming: false,
      }),
    ]);
  });

  it('keeps suppressing unlabeled late chunks until a different invocation is observed', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    storeState.messages.push({
      id: 'msg-stream-old',
      type: 'assistant',
      catId: 'opus',
      content: 'thinking...',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-old' } },
      timestamp: Date.now() - 1000,
    });
    storeState.catInvocations = { opus: { invocationId: 'inv-old' } };

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'final answer',
        origin: 'callback',
        messageId: 'msg-callback-old',
      });
    });

    // Invocation slot is gone, but that alone is not enough proof that a new invocation owns this chunk.
    storeState.catInvocations = {};
    vi.clearAllMocks();

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'stale unlabeled chunk from old invocation',
        origin: 'stream',
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAppendToMessage).not.toHaveBeenCalled();
    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'msg-callback-old',
        catId: 'opus',
        content: 'final answer',
        origin: 'callback',
      }),
    ]);

    storeState.catInvocations = { opus: { invocationId: 'inv-new' } };
    vi.clearAllMocks();

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'verified new invocation first chunk',
        origin: 'stream',
      });
    });

    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        catId: 'opus',
        content: 'verified new invocation first chunk',
        origin: 'stream',
        isStreaming: true,
      }),
    );
  });

  it('falls back to ensureActiveAssistantMessage when no callback message exists', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // No callback messages, just a streaming message
    storeState.messages.push({
      id: 'msg-stream-opus',
      type: 'assistant',
      catId: 'opus',
      content: 'streaming...',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: Date.now(),
    });
    storeState.catInvocations = { opus: { invocationId: 'inv-1' } };

    const testBlock = { id: 'block-2', kind: 'card', v: 1, title: 'test' };
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'rich_block', block: testBlock }),
      });
    });

    // Should fall back to streaming message (existing behavior when no callback exists)
    expect(mockAppendRichBlock).toHaveBeenCalledTimes(1);
  });

  it('replaces an invocationless rich-block placeholder when callback text arrives later', () => {
    mockAddMessage.mockImplementation((message) => {
      storeState.messages.push(message);
    });
    mockAppendRichBlock.mockImplementation((id: string, block: { id: string }) => {
      storeState.messages = storeState.messages.map((message) => {
        if (message.id !== id) return message;
        const rich = message.extra?.rich ?? { v: 1 as const, blocks: [] };
        if (rich.blocks.some((candidate) => candidate.id === block.id)) return message;
        return {
          ...message,
          extra: {
            ...message.extra,
            rich: {
              ...rich,
              blocks: [...rich.blocks, block],
            },
          },
        };
      });
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    const testBlock = { id: 'block-orphan', kind: 'card', v: 1, title: 'CLI Output' };
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'rich_block', block: testBlock }),
      });
    });

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        catId: 'codex',
        origin: 'stream',
        isStreaming: true,
        content: '',
        extra: {
          rich: {
            v: 1,
            blocks: [expect.objectContaining({ id: 'block-orphan' })],
          },
        },
      }),
    ]);
    expect(storeState.messages[0]?.extra?.stream?.invocationId).toBeUndefined();

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        content: 'command finished',
        origin: 'callback',
        messageId: 'msg-callback-codex',
      });
    });

    expect(storeState.messages).toEqual([
      expect.objectContaining({
        id: 'msg-callback-codex',
        catId: 'codex',
        content: 'command finished',
        origin: 'callback',
        isStreaming: false,
        extra: {
          rich: {
            v: 1,
            blocks: [expect.objectContaining({ id: 'block-orphan' })],
          },
        },
      }),
    ]);
  });

  it('skips stale callback when active streaming message exists (cloud P1 fix)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Stale callback from a previous invocation
    storeState.messages.push({
      id: 'cb-old',
      type: 'assistant',
      catId: 'opus',
      content: 'Old callback',
      origin: 'callback',
      timestamp: Date.now() - 5000,
    });

    // Current active streaming message
    storeState.messages.push({
      id: 'stream-now',
      type: 'assistant',
      catId: 'opus',
      content: 'Currently streaming...',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-2' } },
      timestamp: Date.now(),
    });
    storeState.catInvocations = { opus: { invocationId: 'inv-2' } };

    // Rich block from CLI stream (e.g. codex-event-transform image extraction), no messageId
    const testBlock = { id: 'block-stream', kind: 'media_gallery', v: 1, items: [] };
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'rich_block', block: testBlock }),
      });
    });

    // Should NOT go to the stale callback; should go to streaming message
    expect(mockAppendRichBlock).toHaveBeenCalledTimes(1);
    const [targetId] = mockAppendRichBlock.mock.calls[0];
    expect(targetId).not.toBe('cb-old');
    // Should target the streaming message (via ensureActiveAssistantMessage fallback)
    expect(targetId).toBe('stream-now');
  });

  it('rich_block with explicit messageId still uses that messageId (existing behavior preserved)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    const explicitMsgId = 'msg-explicit-target';
    storeState.messages.push({
      id: explicitMsgId,
      type: 'assistant',
      catId: 'opus',
      content: 'target message',
      origin: 'callback',
      timestamp: Date.now(),
    });

    const testBlock = { id: 'block-3', kind: 'card', v: 1, title: 'test' };
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'rich_block', block: testBlock, messageId: explicitMsgId }),
      });
    });

    expect(mockAppendRichBlock).toHaveBeenCalledWith(explicitMsgId, testBlock);
  });
});
