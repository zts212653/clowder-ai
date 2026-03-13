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
  setMessageMetadata: mockSetMessageMetadata,
  setMessageThinking: mockSetMessageThinking,

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
