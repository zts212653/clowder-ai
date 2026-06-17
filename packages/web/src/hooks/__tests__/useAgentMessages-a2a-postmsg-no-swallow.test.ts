/**
 * F194 live A2A post_message no-swallow — ACTIVE-path incident regression net
 * (2026-06-10 incident; see bubble-speech-real-store-no-swallow.test.ts for
 * the full incident provenance). Fix landed via clowder-ai#834 intake
 * (isExplicitPost: explicit posts are invocationless → exempt from stable-key
 * merge/defer/replacement). These tests pin the active-thread behavior surface:
 * both posts visible as separate records, work-log bubble survives, posts are
 * idempotent by server messageId, and speech never flips the streaming state.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetThreadRuntimeSingleton } from '@/hooks/thread-runtime-singleton';
import { useAgentMessages } from '@/hooks/useAgentMessages';

const mockSetStreaming = vi.fn((id: string, streaming: boolean) => {
  storeState.messages = storeState.messages.map((m) => (m.id === id ? { ...m, isStreaming: streaming } : m));
});
const mockSetCatInvocation = vi.fn((catId: string, info: Record<string, unknown>) => {
  storeState.catInvocations = {
    ...storeState.catInvocations,
    [catId]: { ...storeState.catInvocations[catId], ...info },
  };
});
const mockSetMessageStreamInvocation = vi.fn((messageId: string, invocationId: string, turnInvocationId?: string) => {
  storeState.messages = storeState.messages.map((m) =>
    m.id === messageId
      ? {
          ...m,
          extra: {
            ...m.extra,
            stream: { ...m.extra?.stream, invocationId, ...(turnInvocationId ? { turnInvocationId } : {}) },
          },
        }
      : m,
  );
});
const mockAddMessage = vi.fn((msg: unknown) => {
  storeState.messages.push(msg as (typeof storeState.messages)[number]);
});
const mockReplaceMessages = vi.fn((msgs: unknown[]) => {
  storeState.messages = msgs as typeof storeState.messages;
});
const mockRemoveActiveInvocation = vi.fn((invocationId: string) => {
  delete storeState.activeInvocations[invocationId];
});
const mockAddActiveInvocation = vi.fn((invocationId: string, catId: string, mode: string) => {
  storeState.activeInvocations[invocationId] = { catId, mode };
});

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

const storeState = {
  messages: [] as TestMessage[],
  addMessage: mockAddMessage,
  appendToMessage: vi.fn(),
  appendToolEvent: vi.fn(),
  appendRichBlock: vi.fn(),
  setStreaming: mockSetStreaming,
  setLoading: vi.fn(),
  setHasActiveInvocation: vi.fn(),
  setIntentMode: vi.fn(),
  setCatStatus: vi.fn(),
  clearCatStatuses: vi.fn(),
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: vi.fn(),
  requestStreamCatchUp: vi.fn(),
  setMessageMetadata: vi.fn(),
  setMessageThinking: vi.fn((id: string, thinking: string) => {
    storeState.messages = storeState.messages.map((m) => (m.id === id ? { ...m, thinking } : m));
  }),
  replaceMessageId: vi.fn(),
  patchMessage: vi.fn(),
  setMessageStreamInvocation: mockSetMessageStreamInvocation,
  addMessageToThread: vi.fn(),
  replaceMessages: mockReplaceMessages,
  clearThreadActiveInvocation: vi.fn(),
  resetThreadInvocationState: vi.fn(),
  setThreadMessageStreaming: vi.fn(),
  getThreadState: vi.fn(() => ({ messages: [] })),
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

/** 复刻 A2A 复现时序的前奏：thinking + tool 建出 thinking/tools-only stream 泡（content=''）。 */
function streamWorkLogPrelude() {
  captured?.handleAgentMessage({
    type: 'thinking',
    catId: 'sonnet',
    content: '正在思考探针计划',
    invocationId: PARENT_INV,
    turnInvocationId: TURN_INV,
    origin: 'stream',
    threadId: 'thread-1',
    timestamp: 1000,
  });
  captured?.handleAgentMessage({
    type: 'tool_use',
    catId: 'sonnet',
    toolName: 'Read',
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

describe('F194 live A2A post_message no-swallow (Z11 contract on live path)', () => {
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
    resetThreadRuntimeSingleton();
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
    // RED now: 探针A is overwritten by 探针B via stable-key replacement.
    expect(contents).toContain('探针A：开场正式消息');
    expect(contents).toContain('探针B：收尾正式消息');
    // Records carry their server ids (idempotency anchor + hydrate reconciliation).
    const ids = assistantRows().map((m) => m.id);
    expect(ids).toContain('srv-msg-A');
    expect(ids).toContain('srv-msg-B');
  });

  it('speech lands via the reducer write path, NEVER via store addMessage (gpt52 R1 P1-1)', () => {
    // The real store's addMessage runs the TD112 assistant dedup
    // (findAssistantDuplicate Phase 1: same cat + same turn key → hard merge),
    // which would silently fold a turn-stamped speech bubble back into the
    // same-turn stream bubble. The reducer path (replaceMessages, bare array
    // replace) is the only write path that preserves Z11 standalone speech.
    act(() => {
      streamWorkLogPrelude();
    });
    mockAddMessage.mockClear();
    act(() => {
      postMsg('探针A：开场正式消息', 'srv-msg-A', 2000);
    });
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockReplaceMessages).toHaveBeenCalled();
    expect(assistantRows().some((m) => m.id === 'srv-msg-A' && m.origin === 'callback')).toBe(true);
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

  it('preserves the thinking/tools-only stream work-log record when post_message arrives mid-turn', () => {
    act(() => {
      streamWorkLogPrelude();
      postMsg('探针A：开场正式消息', 'srv-msg-A', 2000);
    });

    const rows = assistantRows();
    // RED now: the stream bubble (content='', thinking+tools) is replaced
    // in-place by the callback row; no stream-origin row survives.
    // (thinking CONTENT delivery has its own debounced pipeline + dedicated
    // tests — this test asserts record survival/independence, the bug's
    // actual behavior surface.)
    const streamRow = rows.find((m) => m.origin === 'stream');
    expect(streamRow, 'stream work-log row must survive post_message').toBeTruthy();
    // And the callback row is its own record, not an overwrite of the stream row.
    const callbackRow = rows.find((m) => m.origin === 'callback');
    expect(callbackRow?.content).toBe('探针A：开场正式消息');
    expect(callbackRow?.id).not.toBe(streamRow?.id);
  });

  it('post_message must not flip or hijack the streaming state of the work-log bubble', () => {
    act(() => {
      streamWorkLogPrelude();
    });
    const streamingBefore = assistantRows().filter((m) => m.isStreaming === true).length;
    expect(streamingBefore).toBeGreaterThan(0);

    act(() => {
      postMsg('探针A：开场正式消息', 'srv-msg-A', 2000);
    });

    // The turn is still running: the work-log bubble must still exist as a
    // stream-origin record (post_msg is speech, not the turn terminal).
    const streamRow = assistantRows().find((m) => m.origin === 'stream');
    expect(streamRow, 'work-log bubble must not be consumed by speech').toBeTruthy();
    expect(streamRow?.isStreaming).toBe(true);
  });
});
