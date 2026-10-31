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
  origin?: 'stream' | 'callback';
  toolEvents?: unknown[];
  replyTo?: string;
  replyPreview?: { senderCatId: string | null; content: string };
  extra?: { stream?: { invocationId?: string; turnInvocationId?: string } };
  timestamp: number;
}

function updateMessage(id: string, update: (message: TestMessage) => TestMessage) {
  storeState.messages = storeState.messages.map((m) => (m.id === id ? update(m) : m));
}

/** Thread-scoped writes (hooks/named-message-writer.ts); the current thread's messages are the flat list. */
function forCurrentThread(threadId: string, write: () => void) {
  if (threadId === storeState.currentThreadId) write();
}

const mockAddMessage = vi.fn();
const mockAddMessageToThread = vi.fn((threadId: string, msg: TestMessage) => {
  forCurrentThread(threadId, () => {
    if (!storeState.messages.some((m) => m.id === msg.id)) storeState.messages = [...storeState.messages, msg];
  });
});
const mockAppendToThreadMessage = vi.fn((threadId: string, id: string, content: string) => {
  forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, content: m.content + content })));
});
const mockPatchThreadMessage = vi.fn((threadId: string, id: string, patch: Partial<TestMessage>) => {
  forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, ...patch })));
});
const mockAppendToolEventToThread = vi.fn((threadId: string, id: string, event: unknown) => {
  forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, toolEvents: [...(m.toolEvents ?? []), event] })));
});
const mockSetThreadMessageStreaming = vi.fn((threadId: string, id: string, streaming: boolean) => {
  forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, isStreaming: streaming })));
});

const storeState = {
  messages: [] as TestMessage[],
  catInvocations: {} as Record<string, { invocationId?: string }>,
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
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
  setCatInvocation: vi.fn(),
  setMessageUsage: vi.fn(),
  requestStreamCatchUp: vi.fn(),
  setMessageMetadata: vi.fn(),
  setMessageThinking: vi.fn(),
  patchMessage: vi.fn(),

  getThreadState: vi.fn((threadId: string): { messages: TestMessage[] } => ({
    messages: threadId === storeState.currentThreadId ? storeState.messages : [],
  })),
  addMessageToThread: mockAddMessageToThread,
  appendToThreadMessage: mockAppendToThreadMessage,
  patchThreadMessage: mockPatchThreadMessage,
  appendToolEventToThread: mockAppendToolEventToThread,
  setThreadMessageThinking: vi.fn(),
  appendRichBlockToThread: vi.fn(),
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  setThreadMessageMetadata: vi.fn(),
  setThreadMessageUsage: vi.fn(),
  incrementUnread: vi.fn(),
  clearThreadActiveInvocation: vi.fn(),
  resetThreadInvocationState: vi.fn(),
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

describe('useAgentMessages response writes (no placeholder recovery)', () => {
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

  it('does not reuse an existing post_msg callback message as the stream/tool container', () => {
    storeState.messages = [
      {
        id: 'post-callback',
        type: 'assistant',
        catId: 'opus',
        content: 'post_msg speech should stay separate',
        isStreaming: false,
        origin: 'callback',
        extra: { stream: { invocationId: 'inv-parent', turnInvocationId: 'turn-active' } },
        timestamp: Date.now() - 1000,
      },
    ];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'tool_use',
        catId: 'opus',
        messageId: 'resp-1',
        invocationId: 'inv-parent',
        turnInvocationId: 'turn-active',
        toolName: 'command_execution',
        toolInput: { command: 'git status' },
      });
    });

    expect(mockAppendToolEventToThread).not.toHaveBeenCalledWith('thread-1', 'post-callback', expect.anything());
    const response = storeState.messages.find((m) => m.id === 'resp-1');
    const post = storeState.messages.find((m) => m.id === 'post-callback');
    expect(response).toMatchObject({
      type: 'assistant',
      catId: 'opus',
      origin: 'stream',
      isStreaming: true,
    });
    expect(response?.toolEvents?.length ?? 0).toBeGreaterThan(0);
    expect(post).toMatchObject({
      type: 'assistant',
      catId: 'opus',
      origin: 'callback',
      content: 'post_msg speech should stay separate',
      isStreaming: false,
    });
    expect(post?.toolEvents).toBeUndefined();
  });

  it('keeps writing into the response after replace hydration swaps in its stored copy mid-stream', () => {
    storeState.catInvocations = { opus: { invocationId: 'inv-live-1' } };

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'hello',
        origin: 'stream',
        messageId: 'resp-1',
      });
    });
    expect(storeState.messages.map((m) => m.id)).toEqual(['resp-1']);

    // Hydration replaces the live record with the stored copy of the same response
    // (same server id), which does not carry the client's streaming flag.
    storeState.messages = [
      {
        id: 'resp-1',
        type: 'assistant',
        catId: 'opus',
        content: 'hello',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-live-1' } },
        isStreaming: false,
        timestamp: Date.now(),
      },
    ];
    vi.clearAllMocks();

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: ' world',
        origin: 'stream',
        messageId: 'resp-1',
      });
    });

    expect(mockAddMessageToThread).not.toHaveBeenCalled();
    expect(mockAppendToThreadMessage).toHaveBeenCalledWith('thread-1', 'resp-1', ' world');
    expect(mockSetThreadMessageStreaming).toHaveBeenCalledWith('thread-1', 'resp-1', true);
    expect(storeState.messages).toEqual([expect.objectContaining({ id: 'resp-1', content: 'hello world' })]);
  });

  it('preserves reply threading metadata on the response a stream chunk creates', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        content: '收到，我来处理',
        origin: 'stream',
        messageId: 'resp-1',
        replyTo: 'msg-parent-1',
        replyPreview: { senderCatId: 'opus', content: '@缅因猫 帮忙看一下' },
      });
    });

    const response = storeState.messages.find((m) => m.id === 'resp-1');
    expect(response).toMatchObject({
      type: 'assistant',
      catId: 'codex',
      origin: 'stream',
      content: '收到，我来处理',
      replyTo: 'msg-parent-1',
      replyPreview: { senderCatId: 'opus', content: '@缅因猫 帮忙看一下' },
    });
  });

  it('replaces the response content instead of appending on replace-mode text', () => {
    storeState.messages = [
      {
        id: 'resp-1',
        type: 'assistant',
        catId: 'opus',
        content: '第一段。第二段。',
        isStreaming: true,
        origin: 'stream',
        timestamp: Date.now(),
      },
    ];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: '第一段。插入一句。第二段。',
        textMode: 'replace',
        origin: 'stream',
        messageId: 'resp-1',
      });
    });

    expect(mockPatchThreadMessage).toHaveBeenCalledWith('thread-1', 'resp-1', {
      content: '第一段。插入一句。第二段。',
    });
    expect(mockAppendToThreadMessage).not.toHaveBeenCalled();
    expect(storeState.messages[0]?.content).toBe('第一段。插入一句。第二段。');
  });
});
