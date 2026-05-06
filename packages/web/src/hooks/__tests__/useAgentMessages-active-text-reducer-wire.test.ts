import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetThreadRuntimeSingleton } from '@/hooks/thread-runtime-singleton';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import type { ChatMessage } from '@/stores/chat-types';

// Spy on invariant violation reporter (F183 hot-path gate)
const recordViolationSpy = vi.fn();
vi.mock('@/debug/bubbleInvariantDiagnostics', () => ({
  recordBubbleInvariantViolation: (...args: unknown[]) => recordViolationSpy(...args),
}));

// Forwarding-contract test (round 1 P1 #2): replace reducer with a stub that
// returns a synthetic violation, prove handler calls recordBubbleInvariantViolation.
const forwardingTestReducerStub = vi.fn();
vi.mock('@/stores/bubble-reducer', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    applyBubbleEvent: (input: unknown) => {
      if (forwardingTestReducerStub.getMockImplementation()) {
        return forwardingTestReducerStub(input);
      }
      return (actual.applyBubbleEvent as (i: unknown) => unknown)(input);
    },
  };
});

// F183 Phase B1.2.2 — verify active text stream chunks into an EXISTING bubble
// route through `replaceMessages` (reducer-driven write), not the legacy
// `appendToMessage`/`patchMessage` direct mutation.

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
const mockSetCatInvocation = vi.fn((catId: string, info: Record<string, unknown>) => {
  storeState.catInvocations = {
    ...storeState.catInvocations,
    [catId]: { ...storeState.catInvocations[catId], ...info },
  };
});
const mockSetMessageUsage = vi.fn();
const mockSetMessageMetadata = vi.fn();
const mockSetMessageThinking = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockReplaceMessageId = vi.fn();
const mockPatchMessage = vi.fn();
const mockSetMessageStreamInvocation = vi.fn();
const mockRemoveActiveInvocation = vi.fn();
const mockReplaceMessages = vi.fn((...args: unknown[]) => {
  storeState.messages = args[0] as ChatMessage[];
});

const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({ messages: [] }));

const storeState = {
  messages: [] as ChatMessage[],
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
  setMessageStreamInvocation: mockSetMessageStreamInvocation,
  replaceMessages: mockReplaceMessages,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-1',
  catInvocations: {} as Record<string, { invocationId?: string }>,
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
  hasMore: true,
  removeActiveInvocation: mockRemoveActiveInvocation,
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

describe('F183 Phase B1.2.2 — active text stream wire-up to reducer', () => {
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
    recordViolationSpy.mockClear();
    resetThreadRuntimeSingleton();
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('appends text to existing bubble via replaceMessages (B1.2.2 wire-up)', () => {
    // Pre-state: existing streaming bubble for inv-1
    const existing: ChatMessage = {
      id: 'msg-inv-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'hello',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: 1000,
    };
    storeState.messages = [existing];
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
        invocationId: 'inv-1',
        timestamp: 1100,
      });
    });

    // GREEN expectation: replaceMessages called with reducer-computed next state
    expect(mockReplaceMessages).toHaveBeenCalled();
    const lastCall = mockReplaceMessages.mock.calls[mockReplaceMessages.mock.calls.length - 1];
    const nextMessages = lastCall[0] as ChatMessage[];
    expect(nextMessages).toHaveLength(1);
    expect(nextMessages[0]).toMatchObject({
      id: 'msg-inv-1-codex',
      catId: 'codex',
      content: 'hello world',
      isStreaming: true,
    });

    // Side-effect guard: legacy appendToMessage MUST NOT be called for this branch
    expect(mockAppendToMessage).not.toHaveBeenCalled();
  });

  it('preserves hasMore when applying reducer result (round 1 P1, cloud codex)', () => {
    // Pre-state: existing streaming bubble + hasMore=true (older history still loadable)
    const existing: ChatMessage = {
      id: 'msg-inv-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'hello',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: 1000,
    };
    storeState.messages = [existing];
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
        invocationId: 'inv-1',
        timestamp: 1100,
      });
    });

    // 关键：hasMore 不能被强制设为 false（否则 useChatHistory gates on hasMore，
    // 老历史 pagination 死掉）。复用既有 store hasMore。
    expect(mockReplaceMessages).toHaveBeenCalled();
    const lastCall = mockReplaceMessages.mock.calls[mockReplaceMessages.mock.calls.length - 1];
    expect(lastCall[1]).toBe(true);
  });

  it('forwards reducer violations to invariant gate (round 1 P1 #2, 砚砚)', () => {
    // Forwarding contract: stub reducer to return a synthetic violation, verify
    // handler forwards to recordBubbleInvariantViolation. Triggering a real
    // violation through real reducer requires hard-to-stage state (canonical-split
    // 需要 same messageId + different invocationId 同时落到一条线上); 这里测的是
    // contract not detection — detection 已在 bubble-reducer.test 覆盖。
    forwardingTestReducerStub.mockImplementation(() => ({
      nextMessages: [],
      violations: [
        {
          threadId: 'thread-1',
          actorId: 'codex',
          canonicalInvocationId: 'inv-1',
          bubbleKind: 'assistant_text',
          eventType: 'stream_chunk',
          violationKind: 'canonical-split',
          sourcePath: 'active',
          originPhase: 'stream',
          messageId: 'msg-shared',
          existingMessageId: 'msg-other',
          existingOriginPhase: 'stream',
          timestamp: 1100,
          seq: null,
        },
      ],
      recoveryAction: 'sot-override',
    }));

    // Pre-state: minimal bubble that getOrRecover can find — same invocation,
    // streaming, so wire-up enters the reducer path.
    const existing: ChatMessage = {
      id: 'msg-inv-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'first',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: 1000,
    };
    storeState.messages = [existing];
    storeState.hasMore = true;

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: ' second',
        origin: 'stream',
        invocationId: 'inv-1',
        timestamp: 1100,
      });
    });

    // 关键：reducer 返回 violations 必须被 forward 到 recordBubbleInvariantViolation；
    // 否则 canonical-split / duplicate / phase-regression 在 hot path 静默。
    expect(recordViolationSpy).toHaveBeenCalled();
    const violations = recordViolationSpy.mock.calls.map((c) => c[0]);
    expect(violations.some((v) => v?.violationKind === 'canonical-split')).toBe(true);

    forwardingTestReducerStub.mockReset();
  });

  it('requests stream catch-up when reducer returns catch-up for an active late stream chunk', () => {
    forwardingTestReducerStub.mockImplementation(() => ({
      nextMessages: storeState.messages,
      violations: [],
      recoveryAction: 'catch-up',
    }));

    const existing: ChatMessage = {
      id: 'msg-inv-catchup-codex',
      type: 'assistant',
      catId: 'codex',
      content: '',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-catchup' } },
      timestamp: 1000,
    };
    storeState.messages = [existing];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: 'late stdout tail',
        origin: 'stream',
        invocationId: 'inv-catchup',
        timestamp: 1100,
      });
    });

    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');

    forwardingTestReducerStub.mockReset();
  });

  it('replaces text content via replaceMessages when textMode=replace (B1.2.2 + round 5 P1)', () => {
    // Pre-state: existing streaming bubble for inv-1
    const existing: ChatMessage = {
      id: 'msg-inv-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'old draft text',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
      timestamp: 1000,
    };
    storeState.messages = [existing];
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
        invocationId: 'inv-1',
        textMode: 'replace',
        timestamp: 1100,
      });
    });

    expect(mockReplaceMessages).toHaveBeenCalled();
    const lastCall = mockReplaceMessages.mock.calls[mockReplaceMessages.mock.calls.length - 1];
    const nextMessages = lastCall[0] as ChatMessage[];
    expect(nextMessages[0].content).toBe('rewritten output');

    // legacy patchMessage path for replace must NOT be called for this branch
    expect(mockPatchMessage).not.toHaveBeenCalled();
  });

  // B1.2.3 — active text stream NEW-bubble creation wire-up
  it('creates new stream bubble via reducer + replaceMessages (B1.2.3)', () => {
    // No pre-existing bubble; activeInvocations carries the slot so wire-up
    // can derive invocationId fallback even if msg.invocationId is missing.
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
        invocationId: 'inv-1',
        timestamp: 1000,
      });
    });

    // 关键：new stream bubble 必须通过 reducer + replaceMessages，不直接 addMessage
    expect(mockReplaceMessages).toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
    const lastCall = mockReplaceMessages.mock.calls[mockReplaceMessages.mock.calls.length - 1];
    const nextMessages = lastCall[0] as ChatMessage[];
    expect(nextMessages).toHaveLength(1);
    expect(nextMessages[0]).toMatchObject({
      type: 'assistant',
      catId: 'codex',
      content: 'hello world',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-1' } },
    });
    // ID 与 deriveBubbleId('msg-${inv}-${cat}') 兼容（不带 bubbleKind 后缀）
    expect(nextMessages[0].id).toBe('msg-inv-1-codex');
  });

  // B1.2.4 — callback wire-up with explicit invocationId only (砚砚 verdict)
  // invocationless callback 留 legacy（reducer 没有 activeId / finalized ref / rich
  // placeholder ref 等上下文，硬塞会引入 heuristic merge）

  it('callback with explicit invocationId + matching stream bubble: defers until done, then upgrades via reducer', () => {
    const streaming: ChatMessage = {
      id: 'msg-inv-cb-1-codex',
      type: 'assistant',
      catId: 'codex',
      content: 'streaming...',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: 'inv-cb-1' } },
      timestamp: 1500,
    };
    storeState.messages = [streaming];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: 'final answer',
        origin: 'callback',
        invocationId: 'inv-cb-1',
        messageId: 'msg-inv-cb-1-codex',
        timestamp: 1600,
      });
    });

    expect(mockReplaceMessages).not.toHaveBeenCalled();

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        threadId: 'thread-1',
        invocationId: 'inv-cb-1',
        isFinal: true,
        timestamp: 1700,
      });
    });

    expect(mockReplaceMessages).toHaveBeenCalled();
    const lastCall = mockReplaceMessages.mock.calls[mockReplaceMessages.mock.calls.length - 1];
    const nextMessages = lastCall[0] as ChatMessage[];
    expect(nextMessages).toHaveLength(1);
    expect(nextMessages[0]).toMatchObject({
      id: 'msg-inv-cb-1-codex',
      content: 'final answer',
      isStreaming: false,
      origin: 'callback',
    });
    // legacy patchMessage(content/origin/isStreaming) MUST NOT be invoked
    const contentPatchCalls = mockPatchMessage.mock.calls.filter(
      (c) => c[1]?.content !== undefined || c[1]?.origin !== undefined || c[1]?.isStreaming !== undefined,
    );
    expect(contentPatchCalls).toHaveLength(0);
  });

  it('callback with explicit invocationId + no target: creates standalone via reducer (B1.2.4)', () => {
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
        messageId: 'msg-inv-cb-2-codex',
        timestamp: 2000,
      });
    });

    expect(mockReplaceMessages).toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
    const lastCall = mockReplaceMessages.mock.calls[mockReplaceMessages.mock.calls.length - 1];
    const nextMessages = lastCall[0] as ChatMessage[];
    expect(nextMessages).toHaveLength(1);
    expect(nextMessages[0]).toMatchObject({
      type: 'assistant',
      catId: 'codex',
      content: 'standalone callback',
      isStreaming: false,
      origin: 'callback',
    });
  });

  // 砚砚 round 2 P1 (云端 codex): when reducer returns quarantine, wire-up must fall
  // back to legacy to preserve callback content + skip markReplacedInvocation
  // (otherwise visible missing final answer + suppress later stream chunks).
  it('callback wire-up falls back when reducer quarantines (round 2 P1)', () => {
    forwardingTestReducerStub.mockImplementation(() => ({
      nextMessages: [], // 模拟 quarantine — reducer 没有应用 callback content
      violations: [
        {
          threadId: 'thread-1',
          actorId: 'codex',
          canonicalInvocationId: 'inv-q',
          bubbleKind: 'assistant_text',
          eventType: 'callback_final',
          violationKind: 'duplicate',
          sourcePath: 'callback',
          originPhase: 'callback/history',
          messageId: 'msg-q',
          existingMessageId: 'msg-other',
          existingOriginPhase: 'callback/history',
          timestamp: 2000,
          seq: null,
        },
      ],
      recoveryAction: 'quarantine',
    }));

    storeState.messages = [];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: 'callback authoritative content',
        origin: 'callback',
        invocationId: 'inv-q',
        messageId: 'msg-q',
        timestamp: 2000,
      });
    });

    // 关键：reducer quarantine 时，callback 内容必须通过 legacy fallback 落到 store
    const calledAddMessage = mockAddMessage.mock.calls.some(
      ([m]) => m.origin === 'callback' && m.content === 'callback authoritative content',
    );
    const calledPatchMessage = mockPatchMessage.mock.calls.some(
      (c) =>
        (c[1] as Record<string, unknown>)?.origin === 'callback' &&
        (c[1] as Record<string, unknown>)?.content === 'callback authoritative content',
    );
    expect(calledAddMessage || calledPatchMessage, 'callback content must be delivered via legacy fallback').toBe(true);

    forwardingTestReducerStub.mockReset();
  });

  // 云端 round 4 P1: fallback addMessage(finalId, ...) 在 canonical-split 时与既有
  // bubble id 撞 → store dedup drops insert → callback content 丢。fallback 必须用
  // non-conflicting id 保证 content 一定落到 store。
  it('callback fallback uses non-conflicting id when reducer rejects (round 4 P1)', () => {
    forwardingTestReducerStub.mockImplementation(() => ({
      nextMessages: [],
      violations: [
        {
          threadId: 'thread-1',
          actorId: 'codex',
          canonicalInvocationId: 'inv-collision',
          bubbleKind: 'assistant_text',
          eventType: 'callback_final',
          violationKind: 'canonical-split',
          sourcePath: 'callback',
          originPhase: 'callback/history',
          messageId: 'msg-existing-collision',
          existingMessageId: 'msg-existing-collision',
          existingOriginPhase: 'callback/history',
          timestamp: 3000,
          seq: null,
        },
      ],
      recoveryAction: 'sot-override',
    }));

    // Pre-state: existing bubble with id == msg.messageId (canonical-split)
    const colliding: ChatMessage = {
      id: 'msg-existing-collision',
      type: 'assistant',
      catId: 'codex',
      content: 'pre-existing different content',
      isStreaming: false,
      origin: 'callback',
      timestamp: 2900,
    };
    storeState.messages = [colliding];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: 'callback authoritative content',
        origin: 'callback',
        invocationId: 'inv-collision',
        messageId: 'msg-existing-collision',
        timestamp: 3000,
      });
    });

    // 关键：fallback addMessage 不能用 msg-existing-collision（撞 id 被 dedup 丢弃）
    const addCall = mockAddMessage.mock.calls.find(
      ([m]) => m.origin === 'callback' && m.content === 'callback authoritative content',
    );
    expect(addCall, 'fallback addMessage must be called for callback content').toBeDefined();
    expect(addCall?.[0]?.id, 'fallback id must NOT collide with existing bubble id').not.toBe('msg-existing-collision');

    forwardingTestReducerStub.mockReset();
  });

  // 砚砚 round 2 follow-up: recoveryAction='sot-override' (canonical-split) 与 quarantine
  // 同样代表 reducer 没采纳事件，wire-up 必须 fallback 保 content 且 不 markReplaced
  it('callback wire-up falls back when reducer returns sot-override (round 2 follow-up)', () => {
    forwardingTestReducerStub.mockImplementation(() => ({
      nextMessages: [],
      violations: [
        {
          threadId: 'thread-1',
          actorId: 'codex',
          canonicalInvocationId: 'inv-split',
          bubbleKind: 'assistant_text',
          eventType: 'callback_final',
          violationKind: 'canonical-split',
          sourcePath: 'callback',
          originPhase: 'callback/history',
          messageId: 'msg-split',
          existingMessageId: 'msg-collision',
          existingOriginPhase: 'callback/history',
          timestamp: 2500,
          seq: null,
        },
      ],
      recoveryAction: 'sot-override',
    }));

    storeState.messages = [];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        threadId: 'thread-1',
        content: 'callback content during sot-override',
        origin: 'callback',
        invocationId: 'inv-split',
        messageId: 'msg-split',
        timestamp: 2500,
      });
    });

    // 关键：sot-override 时 callback 内容也必须通过 legacy fallback 落到 store
    const calledAddMessage = mockAddMessage.mock.calls.some(
      ([m]) => m.origin === 'callback' && m.content === 'callback content during sot-override',
    );
    expect(calledAddMessage, 'callback content must be delivered via legacy fallback during sot-override').toBe(true);

    forwardingTestReducerStub.mockReset();
  });

  it('callback with explicit invocationId does NOT hijack contentful unrelated live stream (B1.2.4 narrow guard)', () => {
    // Pre-state: live invocationless stream from a different (untracked) invocation
    const liveStream: ChatMessage = {
      id: 'msg-live',
      type: 'assistant',
      catId: 'codex',
      content: 'I am still streaming',
      isStreaming: true,
      origin: 'stream',
      extra: { stream: {} }, // invocationless
      timestamp: 1000,
    };
    storeState.messages = [liveStream];

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
        messageId: 'msg-different-cb',
        timestamp: 2000,
      });
    });

    expect(mockReplaceMessages).toHaveBeenCalled();
    const lastCall = mockReplaceMessages.mock.calls[mockReplaceMessages.mock.calls.length - 1];
    const nextMessages = lastCall[0] as ChatMessage[];
    // 关键：live stream bubble 必须保留，callback 创建 standalone（narrow guard）
    expect(nextMessages).toHaveLength(2);
    const liveAfter = nextMessages.find((m) => m.id === 'msg-live');
    expect(liveAfter?.content, 'live stream content must NOT be hijacked').toBe('I am still streaming');
    const cbAfter = nextMessages.find((m) => m.id === 'msg-different-cb');
    expect(cbAfter, 'standalone callback bubble must be created').toBeDefined();
  });
});
