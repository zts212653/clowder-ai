import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

interface TestMessage {
  id: string;
  type: string;
  catId?: string;
  content: string;
  isStreaming?: boolean;
  origin?: string;
  timestamp: number;
}

const mockAddMessage = vi.fn();
const mockAppendRichBlock = vi.fn();
const mockAppendRichBlockToThread = vi.fn();

const storeState = {
  messages: [] as TestMessage[],
  addMessage: mockAddMessage,
  appendToMessage: vi.fn(),
  appendToolEvent: vi.fn(),
  appendRichBlock: mockAppendRichBlock,
  setStreaming: vi.fn(),
  setLoading: vi.fn(),
  setHasActiveInvocation: vi.fn(),
  setIntentMode: vi.fn(),
  setCatStatus: vi.fn(),
  clearCatStatuses: vi.fn(),
  setCatInvocation: vi.fn(),
  setMessageUsage: vi.fn(),
  requestStreamCatchUp: vi.fn(),
  setMessageMetadata: vi.fn(),
  setMessageThinking: vi.fn(),
  removeActiveInvocation: vi.fn(),
  patchMessage: vi.fn(),

  // Named-message writes (hooks/named-message-writer.ts) — thread-scoped
  getThreadState: vi.fn((threadId: string): { messages: TestMessage[] } => ({
    messages: threadId === storeState.currentThreadId ? storeState.messages : [],
  })),
  addMessageToThread: vi.fn(),
  appendToThreadMessage: vi.fn(),
  patchThreadMessage: vi.fn(),
  appendToolEventToThread: vi.fn(),
  setThreadMessageThinking: vi.fn(),
  appendRichBlockToThread: mockAppendRichBlockToThread,
  setThreadMessageStreaming: vi.fn(),
  setThreadMessageMetadata: vi.fn(),
  setThreadMessageUsage: vi.fn(),
  incrementUnread: vi.fn(),
  clearThreadActiveInvocation: vi.fn(),
  resetThreadInvocationState: vi.fn(),
  currentThreadId: 'thread-1',
  catInvocations: {} as Record<string, { invocationId?: string; turnInvocationId?: string }>,
  activeInvocations: {} as Record<string, { catId?: string }>,
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
    storeState.activeInvocations = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("rich_block with an explicit payload messageId lands in that post, not in the envelope's response", () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // The turn's response R (streaming) and a post_message P that the cat posted.
    storeState.messages.push(
      {
        id: 'resp-1',
        type: 'assistant',
        catId: 'opus',
        content: 'I am streaming...',
        isStreaming: true,
        origin: 'stream',
        timestamp: Date.now() - 1000,
      },
      {
        id: 'post-explicit-target',
        type: 'assistant',
        catId: 'opus',
        content: 'target message',
        origin: 'callback',
        timestamp: Date.now(),
      },
    );

    // The server stamps the turn's response on the envelope; the payload names the post's own id.
    const testBlock = { id: 'block-3', kind: 'card', v: 1, title: 'test' };
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        messageId: 'resp-1',
        content: JSON.stringify({ type: 'rich_block', block: testBlock, messageId: 'post-explicit-target' }),
      });
    });

    expect(mockAppendRichBlockToThread).toHaveBeenCalledTimes(1);
    expect(mockAppendRichBlockToThread).toHaveBeenCalledWith('thread-1', 'post-explicit-target', testBlock);
    expect(mockAppendRichBlockToThread).not.toHaveBeenCalledWith('thread-1', 'resp-1', testBlock);
    expect(mockAppendRichBlock).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});
