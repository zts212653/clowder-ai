/**
 * F194 live A2A post_message no-swallow — ACTIVE-path incident regression net
 * (2026-06-10 incident; see bubble-speech-real-store-no-swallow.test.ts for
 * the full incident provenance). Under the named-message model every stream
 * event of the turn names its response R, and a post_message callback names
 * its own stored message P: the client writes each event into the message it
 * names. These tests pin the active-thread behavior surface: both posts
 * visible as separate records, the work-log response survives, posts are
 * idempotent by server messageId, and speech never flips the streaming state.
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
  isStreaming?: boolean;
  origin?: string;
  thinking?: string;
  toolEvents?: unknown[];
  extra?: {
    stream?: { invocationId?: string; turnInvocationId?: string };
  };
  timestamp: number;
}

function updateMessage(id: string, update: (message: TestMessage) => TestMessage) {
  storeState.messages = storeState.messages.map((m) => (m.id === id ? update(m) : m));
}

/** Thread-scoped writes (hooks/named-message-writer.ts); the current thread's messages are the flat list. */
function forCurrentThread(threadId: string, write: () => void) {
  if (threadId === storeState.currentThreadId) write();
}

const mockSetCatInvocation = vi.fn((catId: string, info: Record<string, unknown>) => {
  storeState.catInvocations = {
    ...storeState.catInvocations,
    [catId]: { ...storeState.catInvocations[catId], ...info },
  };
});
const mockAddMessage = vi.fn((msg: unknown) => {
  storeState.messages.push(msg as TestMessage);
});
const mockRemoveActiveInvocation = vi.fn((invocationId: string) => {
  delete storeState.activeInvocations[invocationId];
});
const mockAddActiveInvocation = vi.fn((invocationId: string, catId: string, mode: string) => {
  storeState.activeInvocations[invocationId] = { catId, mode };
});

const storeState = {
  messages: [] as TestMessage[],
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
  getThreadState: vi.fn((threadId: string): { messages: TestMessage[] } => ({
    messages: threadId === storeState.currentThreadId ? storeState.messages : [],
  })),
  addMessageToThread: vi.fn((threadId: string, msg: TestMessage) => {
    forCurrentThread(threadId, () => {
      if (!storeState.messages.some((m) => m.id === msg.id)) storeState.messages.push(msg);
    });
  }),
  appendToThreadMessage: vi.fn((threadId: string, id: string, content: string) => {
    forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, content: m.content + content })));
  }),
  patchThreadMessage: vi.fn((threadId: string, id: string, patch: Partial<TestMessage>) => {
    forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, ...patch })));
  }),
  appendToolEventToThread: vi.fn((threadId: string, id: string, event: unknown) => {
    forCurrentThread(threadId, () =>
      updateMessage(id, (m) => ({ ...m, toolEvents: [...(m.toolEvents ?? []), event] })),
    );
  }),
  setThreadMessageThinking: vi.fn((threadId: string, id: string, thinking: string) => {
    forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, thinking })));
  }),
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
  catInvocations: {} as Record<string, { invocationId?: string; turnInvocationId?: string }>,
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
  removeActiveInvocation: mockRemoveActiveInvocation,
  addActiveInvocation: mockAddActiveInvocation,
  replaceThreadTargetCats: vi.fn(),
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

const PARENT_INV = 'parent-chain-inv-1';
const TURN_INV = 'turn-inv-1';
/** The turn's response, stored empty by the server at dispatch; every stream event names it. */
const RESPONSE_ID = 'resp-1';

/** 复刻 A2A 复现时序的前奏：thinking + tool 写进本轮 response（content=''，只有 thinking/tools）。 */
function streamWorkLogPrelude() {
  captured?.handleAgentMessage({
    type: 'system_info',
    catId: 'sonnet',
    content: JSON.stringify({ type: 'thinking', catId: 'sonnet', text: '正在思考探针计划' }),
    messageId: RESPONSE_ID,
    invocationId: PARENT_INV,
    turnInvocationId: TURN_INV,
    threadId: 'thread-1',
    timestamp: 1000,
  });
  captured?.handleAgentMessage({
    type: 'tool_use',
    catId: 'sonnet',
    toolName: 'Read',
    messageId: RESPONSE_ID,
    invocationId: PARENT_INV,
    turnInvocationId: TURN_INV,
    origin: 'stream',
    threadId: 'thread-1',
    timestamp: 1100,
  });
}

function postMsg(content: string, messageId: string, timestamp: number) {
  captured?.handleAgentMessage({
    type: 'text',
    catId: 'sonnet',
    content,
    messageId,
    invocationId: PARENT_INV,
    turnInvocationId: TURN_INV,
    origin: 'callback',
    extra: { isExplicitPost: true },
    threadId: 'thread-1',
    timestamp,
  });
}

function assistantRows(): TestMessage[] {
  return storeState.messages.filter((m) => m.type === 'assistant' && m.catId === 'sonnet');
}

describe('F194 live A2A post_message no-swallow (named-message contract on live path)', () => {
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
    act(() => {
      root.render(React.createElement(Harness));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps both own-id post_messages as separate records (no swallow chain)', () => {
    act(() => {
      streamWorkLogPrelude();
      postMsg('探针A：开场正式消息', 'srv-msg-A', 2000);
      postMsg('探针B：收尾正式消息', 'srv-msg-B', 3000);
    });

    const contents = assistantRows().map((m) => m.content);
    expect(contents).toContain('探针A：开场正式消息');
    expect(contents).toContain('探针B：收尾正式消息');
    // Records carry their server ids (idempotency anchor + hydrate reconciliation),
    // beside the turn's response.
    const ids = assistantRows().map((m) => m.id);
    expect(ids).toContain('srv-msg-A');
    expect(ids).toContain('srv-msg-B');
    expect(ids).toContain(RESPONSE_ID);
  });

  it('replaying the same speech messageId is idempotent (no duplicate bubble)', () => {
    act(() => {
      streamWorkLogPrelude();
      postMsg('探针A：开场正式消息', 'srv-msg-A', 2000);
      postMsg('探针A：开场正式消息', 'srv-msg-A', 2100); // reconnect replay
    });
    const matches = assistantRows().filter((m) => m.id === 'srv-msg-A');
    expect(matches).toHaveLength(1);
  });

  it('preserves the thinking/tools-only work-log response when post_message arrives mid-turn', () => {
    act(() => {
      streamWorkLogPrelude();
      postMsg('探针A：开场正式消息', 'srv-msg-A', 2000);
    });

    const rows = assistantRows();
    // The response (content='', thinking+tools) is not replaced in-place by the callback row.
    // (thinking CONTENT delivery has its own dedicated tests — this test asserts record
    // survival/independence, the bug's actual behavior surface.)
    const streamRow = rows.find((m) => m.origin === 'stream');
    expect(streamRow, 'stream work-log row must survive post_message').toBeTruthy();
    expect(streamRow?.id).toBe(RESPONSE_ID);
    expect(streamRow?.toolEvents?.length ?? 0).toBeGreaterThan(0);
    // And the callback row is its own record, not an overwrite of the stream row.
    const callbackRow = rows.find((m) => m.origin === 'callback');
    expect(callbackRow?.id).toBe('srv-msg-A');
    expect(callbackRow?.content).toBe('探针A：开场正式消息');
    expect(callbackRow?.id).not.toBe(streamRow?.id);
  });

  it('post_message must not flip or hijack the streaming state of the work-log response', () => {
    act(() => {
      streamWorkLogPrelude();
    });
    const streamingBefore = assistantRows().filter((m) => m.isStreaming === true).length;
    expect(streamingBefore).toBeGreaterThan(0);

    act(() => {
      postMsg('探针A：开场正式消息', 'srv-msg-A', 2000);
    });

    // The turn is still running: the work-log response must still exist as a
    // stream-origin record (post_msg is speech, not the turn terminal).
    const streamRow = assistantRows().find((m) => m.origin === 'stream');
    expect(streamRow, 'work-log bubble must not be consumed by speech').toBeTruthy();
    expect(streamRow?.id).toBe(RESPONSE_ID);
    expect(streamRow?.isStreaming).toBe(true);
  });
});
