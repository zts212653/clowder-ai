/**
 * F173 Phase E Task 6 (AC-E3) — cross-thread handoff fixture
 *
 * 钉 thread_mo6 双气泡场景外部行为不变量（observable，不绑内部 delegate）：
 *
 *   砚砚 PR #1423 review P1: 旧版 fixture mock 掉 background helper，只验
 *   "delegate 被调用"，没钉 AC-E3 真正关心的 "active→background→active 期间同
 *   invocation 不产生第二个 bubble id"。Task 3-5 迁移期间该 fixture 必须保持绿。
 *
 *   本版本不 mock useAgentMessages — real handleBackgroundAgentMessage 跑通；
 *   只 mock chatStore，断言 store 收到的 message id 在 active 和 bg 路径下都是
 *   同一份（deriveBubbleId(invocationId, catId) → msg-{inv}-{cat} 是 deterministic）。
 *
 * 对外 invariant 不变量（重构后必须保持绿）:
 *   - same invocation across thread switch → 唯一 bubble id (no double-bubble)
 *   - active path 调 store.addMessage with id = `msg-{inv}-{cat}`
 *   - bg path 调 store.addMessageToThread with id = same `msg-{inv}-{cat}`
 *   - invocationless fallback case 也走对应 thread 写路径
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

// 不 mock useAgentMessages — real handleBackgroundAgentMessage 跑通

const mockAddMessage = vi.fn();
const mockSetCatStatus = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockAppendRichBlock = vi.fn();
const mockSetStreaming = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetIntentMode = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetMessageUsage = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockSetMessageMetadata = vi.fn();
const mockSetMessageThinking = vi.fn();
const mockSetMessageStreamInvocation = vi.fn();
const mockPatchMessage = vi.fn();
const mockReplaceMessageId = vi.fn();
const mockRemoveMessage = vi.fn();
const mockAddActiveInvocation = vi.fn();
const mockClearAllActiveInvocations = vi.fn();
const mockRemoveActiveInvocation = vi.fn();

// bg-path writers (real handleBackgroundAgentMessage will call these)
const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockAppendToThreadMessage = vi.fn();
const mockAppendToolEventToThread = vi.fn();
const mockAppendRichBlockToThread = vi.fn();
const mockSetThreadCatInvocation = vi.fn();
const mockSetThreadMessageMetadata = vi.fn();
const mockSetThreadMessageUsage = vi.fn();
const mockSetThreadMessageThinking = vi.fn();
const mockSetThreadMessageStreamInvocation = vi.fn();
const mockSetThreadLoading = vi.fn();
const mockSetThreadHasActiveInvocation = vi.fn();
const mockAddThreadActiveInvocation = vi.fn();
const mockRemoveThreadActiveInvocation = vi.fn();
const mockUpdateThreadCatStatus = vi.fn();
const mockBatchStreamChunkUpdate = vi.fn();
const mockReplaceThreadTargetCats = vi.fn();
const mockReplaceThreadMessageId = vi.fn();
const mockPatchThreadMessage = vi.fn();
const mockRemoveThreadMessage = vi.fn();
const mockGetThreadState = vi.fn(() => ({
  messages: [] as Array<{ id: string; type: string; isStreaming?: boolean; extra?: unknown }>,
  catInvocations: {} as Record<string, { invocationId?: string }>,
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
  catStatuses: {} as Record<string, string>,
}));

const storeState = {
  messages: [] as Array<{ id: string; type: string; catId?: string; content: string; timestamp: number }>,
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
  patchMessage: mockPatchMessage,
  replaceMessageId: mockReplaceMessageId,
  removeMessage: mockRemoveMessage,
  addActiveInvocation: mockAddActiveInvocation,
  clearAllActiveInvocations: mockClearAllActiveInvocations,
  removeActiveInvocation: mockRemoveActiveInvocation,

  addMessageToThread: mockAddMessageToThread,
  // F183 B1.2.3: active stream new-bubble path → reducer → replaceMessages
  replaceMessages: vi.fn((msgs: unknown[]) => {
    storeState.messages = msgs as typeof storeState.messages;
  }),
  // F183 B1.7+: bg path reducer wire-up → replaceThreadMessages (thread-scoped)
  replaceThreadMessages: vi.fn(),
  incrementUnread: vi.fn(),
  hasMore: true,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  appendToThreadMessage: mockAppendToThreadMessage,
  appendToolEventToThread: mockAppendToolEventToThread,
  appendRichBlockToThread: mockAppendRichBlockToThread,
  setThreadCatInvocation: mockSetThreadCatInvocation,
  setThreadMessageMetadata: mockSetThreadMessageMetadata,
  setThreadMessageUsage: mockSetThreadMessageUsage,
  setThreadMessageThinking: mockSetThreadMessageThinking,
  setThreadMessageStreamInvocation: mockSetThreadMessageStreamInvocation,
  setThreadLoading: mockSetThreadLoading,
  setThreadHasActiveInvocation: mockSetThreadHasActiveInvocation,
  addThreadActiveInvocation: mockAddThreadActiveInvocation,
  removeThreadActiveInvocation: mockRemoveThreadActiveInvocation,
  updateThreadCatStatus: mockUpdateThreadCatStatus,
  batchStreamChunkUpdate: mockBatchStreamChunkUpdate,
  replaceThreadTargetCats: mockReplaceThreadTargetCats,
  replaceThreadMessageId: mockReplaceThreadMessageId,
  patchThreadMessage: mockPatchThreadMessage,
  removeThreadMessage: mockRemoveThreadMessage,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-A',
};

vi.mock('@/stores/chatStore', () => {
  const useChatStoreMock = Object.assign(() => storeState, { getState: () => storeState });
  return { useChatStore: useChatStoreMock };
});

const mockAddToast = vi.fn();
vi.mock('@/stores/toastStore', () => ({
  useToastStore: { getState: () => ({ addToast: mockAddToast }) },
}));

let captured: ReturnType<typeof useAgentMessages> | undefined;
function Harness() {
  captured = useAgentMessages();
  return null;
}

describe('useAgentMessages — F173 Phase E AC-E3 cross-thread handoff (observable, not mock-based)', () => {
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
    storeState.currentThreadId = 'thread-A';
    storeState.messages = [];
    mockGetThreadState.mockImplementation(() => ({
      messages: [],
      catInvocations: {} as Record<string, { invocationId?: string }>,
      activeInvocations: {} as Record<string, { catId: string; mode: string }>,
      catStatuses: {} as Record<string, string>,
    }));
    vi.clearAllMocks();
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('AC-E3 invariant: same invocationId across A→B→A switch produces single deterministic bubble id (msg-{inv}-{cat})', () => {
    const EXPECTED_BUBBLE_ID = 'msg-inv-1-opus';

    storeState.currentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Phase 1: user on A, msg.threadId=A, invocationId=inv-1 → active path
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-A',
        invocationId: 'inv-1',
        content: 'thinking...',
        timestamp: 1000,
      });
    });
    // Active path: F183 B1.2.3 wire-up routes new stream bubble through reducer
    // + replaceMessages (instead of addMessage). Find the bubble in either path.
    const replaceMessagesMock = storeState.replaceMessages as ReturnType<typeof vi.fn>;
    const activeAddCalls = mockAddMessage.mock.calls.filter((c) => c[0]?.id === EXPECTED_BUBBLE_ID);
    const replacedBubbles = replaceMessagesMock.mock.calls
      .flatMap((c) => c[0] as Array<{ id?: string; catId?: string; content?: string }>)
      .filter((m) => m.id === EXPECTED_BUBBLE_ID);
    const phase1Bubble = activeAddCalls[0]?.[0] ?? replacedBubbles[0];
    expect(phase1Bubble, 'Phase 1 must produce bubble with deterministic id').toBeDefined();
    expect(phase1Bubble).toMatchObject({
      id: EXPECTED_BUBBLE_ID,
      catId: 'opus',
      content: 'thinking...',
    });

    // Phase 2: user switches to B. Same invocation continues on A.
    storeState.currentThreadId = 'thread-B';
    vi.clearAllMocks();
    mockGetThreadState.mockImplementation((tid?: string) => ({
      messages: [], // bg path will create the bubble fresh in threadStates
      catInvocations: (tid === 'thread-A' ? { opus: { invocationId: 'inv-1' } } : {}) as Record<
        string,
        { invocationId?: string }
      >,
      activeInvocations: (tid === 'thread-A' ? { 'inv-1': { catId: 'opus', mode: 'execute' } } : {}) as Record<
        string,
        { catId: string; mode: string }
      >,
      catStatuses: {} as Record<string, string>,
    }));

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-A', // still A — invocation 还在 A
        invocationId: 'inv-1',
        content: 'CLI Output 20 tools 1m38s',
        timestamp: 2000,
      });
    });
    // F183 B1.8: bg path canonical wire-up — accept either reducer-routed
    // replaceThreadMessages OR legacy addMessageToThread. Both must use the
    // same deterministic bubble id (deriveBubbleId is canonical).
    const bgAddToThreadCalls = mockAddMessageToThread.mock.calls.filter(
      (c) => c[0] === 'thread-A' && c[1]?.id === EXPECTED_BUBBLE_ID,
    );
    const bgReplaceCalls = (storeState.replaceThreadMessages as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === 'thread-A')
      .flatMap((c) => (c[1] as Array<{ id?: string; catId?: string }>) ?? [])
      .filter((m) => m.id === EXPECTED_BUBBLE_ID);
    expect(bgAddToThreadCalls.length + bgReplaceCalls.length).toBeGreaterThan(0);
    // 云端 Codex P2 (PR #1423): negative assertion that bg-only path doesn't
    // also pollute flat (active) state. Without this, a regression introducing
    // dual dispatch (bg AND active writes for same event) would silently pass.
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAppendToMessage).not.toHaveBeenCalled();

    // Phase 3: user back to A. Same invocation continues.
    storeState.currentThreadId = 'thread-A';
    vi.clearAllMocks();

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        threadId: 'thread-A',
        invocationId: 'inv-1',
        content: 'final',
        timestamp: 3000,
      });
    });
    // Active path again — uses same deterministic id (or appends to existing via patch)
    // F183 B1.2.3: also accept replaceMessages-routed write
    const phase3AddIds = mockAddMessage.mock.calls.map((c) => c[0]?.id);
    const phase3AppendIds = mockAppendToMessage.mock.calls.map((c) => c[0]);
    const phase3ReplaceIds = (storeState.replaceMessages as ReturnType<typeof vi.fn>).mock.calls
      .flatMap((c) => c[0] as Array<{ id?: string }>)
      .map((m) => m.id);
    const allIds = [...phase3AddIds, ...phase3AppendIds, ...phase3ReplaceIds];
    // 云端 Codex P1 (PR #1423): every() vacuously true on empty array — must
    // also assert at least one active-path write happened.
    expect(allIds.length).toBeGreaterThan(0);
    expect(allIds.every((id) => !id || id === EXPECTED_BUBBLE_ID)).toBe(true);
  });

  it('AC-E3 invariant: bg-only invocation (user never on that thread) writes to threadStates with deterministic id', () => {
    const EXPECTED_BUBBLE_ID = 'msg-inv-bg-only-gpt52';

    storeState.currentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Bg invocation: msg.threadId=B, currentThread=A → bg path
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'gpt52',
        threadId: 'thread-B',
        invocationId: 'inv-bg-only',
        content: 'bg streaming',
        timestamp: 1000,
      });
    });
    // F183 B1.8: canonical bg → reducer → replaceThreadMessages 优先；mock on
    // no-op fallback 才走 addMessageToThread。两路都接受 deterministic id 即可。
    const bgAddCalls = mockAddMessageToThread.mock.calls.filter(
      (c) => c[0] === 'thread-B' && c[1]?.id === EXPECTED_BUBBLE_ID,
    );
    const bgReplaceCalls = (storeState.replaceThreadMessages as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === 'thread-B')
      .flatMap((c) => (c[1] as Array<{ id?: string }>) ?? [])
      .filter((m) => m.id === EXPECTED_BUBBLE_ID);
    expect(bgAddCalls.length + bgReplaceCalls.length).toBeGreaterThan(0);
    // Active flat state NOT touched
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('AC-E3 invariant: invocationless fallback (legacy event with no invocationId) — bg gets non-deterministic id', () => {
    storeState.currentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Bg msg without invocationId — falls back to bg-{ts}-{cat}-{seq} (legacy fallback)
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'gpt52',
        threadId: 'thread-B',
        content: 'no inv',
        timestamp: 5000,
      });
    });
    expect(mockAddMessageToThread).toHaveBeenCalled();
    const bgCalls = mockAddMessageToThread.mock.calls.filter((c) => c[0] === 'thread-B');
    expect(bgCalls.length).toBeGreaterThan(0);
    // Without invocationId, falls back — id has bg- prefix
    const id = bgCalls[0]?.[1]?.id;
    expect(id).toMatch(/^(bg-|msg-)/); // 容纳两种 fallback 前缀（Task 3-5 删 bg- 后会变 msg-）
  });
});
