import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import type { ChatMessage, ChatMessagePatch } from '@/stores/chat-types';

// Active text stream chunks write into the message they name (msg.messageId = the turn's
// response R) through the thread-scoped named-message writes; a post_message callback is its
// own message under its own server id. No bubble id is invented, guessed, renamed or merged.

function updateMessage(id: string, update: (message: ChatMessage) => ChatMessage) {
  storeState.messages = storeState.messages.map((m) => (m.id === id ? update(m) : m));
}

/** Thread-scoped writes (hooks/named-message-writer.ts); the current thread's messages are the flat list. */
function forCurrentThread(threadId: string, write: () => void) {
  if (threadId === storeState.currentThreadId) write();
}

const mockAddMessage = vi.fn();
const mockSetCatInvocation = vi.fn((catId: string, info: Record<string, unknown>) => {
  storeState.catInvocations = {
    ...storeState.catInvocations,
    [catId]: { ...storeState.catInvocations[catId], ...info },
  };
});
// Whole-list rewrites are not a streaming write path; kept only as a spy.
const mockReplaceMessages = vi.fn();
const mockAddMessageToThread = vi.fn((threadId: string, msg: ChatMessage) => {
  forCurrentThread(threadId, () => {
    if (!storeState.messages.some((m) => m.id === msg.id)) storeState.messages = [...storeState.messages, msg];
  });
});

const storeState = {
  messages: [] as ChatMessage[],
  addMessage: mockAddMessage,
  appendToMessage: vi.fn(),
  appendToolEvent: vi.fn(),
  appendRichBlock: vi.fn(),
  setStreaming: vi.fn(),
  setLoading: vi.fn(),
  setHasActiveInvocation: vi.fn(),
  setIntentMode: vi.fn(),
  setCatStatus: vi.fn(),
  clearCatStatuses: vi.fn(),
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: vi.fn(),
  requestStreamCatchUp: vi.fn(),
  setMessageMetadata: vi.fn(),
  setMessageThinking: vi.fn(),
  patchMessage: vi.fn(),
  replaceMessages: mockReplaceMessages,

  getThreadState: vi.fn((threadId: string): { messages: ChatMessage[] } => ({
    messages: threadId === storeState.currentThreadId ? storeState.messages : [],
  })),
  addMessageToThread: mockAddMessageToThread,
  appendToThreadMessage: vi.fn((threadId: string, id: string, content: string) => {
    forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, content: m.content + content })));
  }),
  patchThreadMessage: vi.fn((threadId: string, id: string, patch: ChatMessagePatch) => {
    forCurrentThread(threadId, () =>
      updateMessage(id, (m) => ({ ...m, ...patch, ...(patch.extra ? { extra: { ...m.extra, ...patch.extra } } : {}) })),
    );
  }),
  appendToolEventToThread: vi.fn(),
  setThreadMessageThinking: vi.fn(),
  appendRichBlockToThread: vi.fn(),
  setThreadMessageStreaming: vi.fn((threadId: string, id: string, streaming: boolean) => {
    forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, isStreaming: streaming })));
  }),
  setThreadMessageMetadata: vi.fn(),
  setThreadMessageUsage: vi.fn(),
  incrementUnread: vi.fn(),
  clearThreadActiveInvocation: vi.fn(),
  resetThreadInvocationState: vi.fn(),
  currentThreadId: 'thread-1',
  catInvocations: {} as Record<string, { invocationId?: string }>,
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
  hasMore: true,
  removeActiveInvocation: vi.fn(),
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

/** The turn's response as the store holds it mid-stream. */
function streamingResponse(content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'resp-1',
    type: 'assistant',
    catId: 'codex',
    content,
    isStreaming: true,
    origin: 'stream',
    extra: { stream: { invocationId: 'inv-1' } },
    timestamp: 1000,
    ...overrides,
  };
}

describe('active text stream writes into the named message', () => {
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
    storeState.hasMore = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('appends text to the response the chunk names', () => {
    storeState.messages = [streamingResponse('hello')];
    storeState.catInvocations = { codex: { invocationId: 'inv-1' } };

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: ' world',
        origin: 'stream',
        messageId: 'resp-1',
        invocationId: 'inv-1',
        timestamp: 1100,
      });
    });

    expect(storeState.messages).toHaveLength(1);
    expect(storeState.messages[0]).toMatchObject({
      id: 'resp-1',
      catId: 'codex',
      content: 'hello world',
      isStreaming: true,
    });
  });

  it('keeps typed child execution identity on the live response before F5', () => {
    storeState.messages = [
      streamingResponse('visible reply', {
        extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'child-ordinary' } },
      }),
    ];
    storeState.catInvocations = { codex: { invocationId: 'parent-1' } };

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: ' complete',
        origin: 'stream',
        messageId: 'resp-1',
        invocationId: 'parent-1',
        turnInvocationId: 'child-ordinary',
        extra: {
          turnExecution: {
            invocationId: 'child-ordinary',
            parentInvocationId: 'parent-1',
            executionKind: 'ordinary',
          },
          auxiliaryTurnExecutions: [
            {
              invocationId: 'child-routing-guard',
              parentInvocationId: 'parent-1',
              executionKind: 'routing_guard',
            },
          ],
        },
        timestamp: 1100,
      });
    });

    const liveResponse = storeState.messages.find((message) => message.id === 'resp-1');
    expect(liveResponse?.content).toBe('visible reply complete');
    expect(liveResponse?.extra?.turnExecution).toEqual({
      invocationId: 'child-ordinary',
      parentInvocationId: 'parent-1',
      executionKind: 'ordinary',
    });
    expect(liveResponse?.extra?.auxiliaryTurnExecutions).toEqual([
      {
        invocationId: 'child-routing-guard',
        parentInvocationId: 'parent-1',
        executionKind: 'routing_guard',
      },
    ]);
  });

  it('streams into the response in place, leaving hasMore (history pagination) alone (round 1 P1, cloud codex)', () => {
    storeState.messages = [streamingResponse('hello')];
    storeState.hasMore = true;

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: ' world',
        origin: 'stream',
        messageId: 'resp-1',
        invocationId: 'inv-1',
        timestamp: 1100,
      });
    });

    // 关键：hasMore 不能被强制设为 false（否则 useChatHistory gates on hasMore，
    // 老历史 pagination 死掉）。流式写入只改 R 本身，不整表重写消息列表。
    expect(storeState.messages[0]?.content).toBe('hello world');
    expect(mockReplaceMessages).not.toHaveBeenCalled();
    expect(storeState.hasMore).toBe(true);
  });

  it('replaces the response text when textMode=replace (round 5 P1)', () => {
    storeState.messages = [streamingResponse('old draft text')];
    storeState.catInvocations = { codex: { invocationId: 'inv-1' } };

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: 'rewritten output',
        origin: 'stream',
        messageId: 'resp-1',
        invocationId: 'inv-1',
        textMode: 'replace',
        timestamp: 1100,
      });
    });

    expect(storeState.messages).toHaveLength(1);
    expect(storeState.messages[0]?.content).toBe('rewritten output');
  });

  it('creates the response under its server id when this client has not seen it yet', () => {
    storeState.messages = [];
    storeState.activeInvocations = { 'inv-1': { catId: 'codex', mode: 'stream' } };

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: 'hello world',
        origin: 'stream',
        messageId: 'resp-1',
        invocationId: 'inv-1',
        timestamp: 1000,
      });
    });

    expect(mockAddMessageToThread).toHaveBeenCalledWith('thread-1', expect.objectContaining({ id: 'resp-1' }));
    expect(storeState.messages).toHaveLength(1);
    expect(storeState.messages[0]).toMatchObject({
      id: 'resp-1',
      type: 'assistant',
      catId: 'codex',
      content: 'hello world',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
    });
  });

  it('a post_message callback is stored whole as its own message under its server id', () => {
    storeState.messages = [];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: 'standalone callback',
        origin: 'callback',
        invocationId: 'inv-cb-2',
        messageId: 'post-cb-2',
        timestamp: 2000,
      });
    });

    expect(storeState.messages).toHaveLength(1);
    expect(storeState.messages[0]).toMatchObject({
      id: 'post-cb-2',
      type: 'assistant',
      catId: 'codex',
      content: 'standalone callback',
      isStreaming: false,
      origin: 'callback',
    });
  });

  it('a post_message callback does NOT hijack the contentful live response', () => {
    storeState.messages = [streamingResponse('I am still streaming', { extra: { stream: {} } })];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: 'callback for different invocation',
        origin: 'callback',
        invocationId: 'inv-different',
        messageId: 'post-different-cb',
        timestamp: 2000,
      });
    });

    // 关键：live response 必须保留，callback 是它自己的 message
    expect(storeState.messages).toHaveLength(2);
    const liveAfter = storeState.messages.find((m) => m.id === 'resp-1');
    expect(liveAfter?.content, 'live stream content must NOT be hijacked').toBe('I am still streaming');
    expect(liveAfter?.isStreaming).toBe(true);
    const cbAfter = storeState.messages.find((m) => m.id === 'post-different-cb');
    expect(cbAfter, 'standalone callback message must be created').toBeDefined();
    expect(cbAfter?.content).toBe('callback for different invocation');
  });
});
