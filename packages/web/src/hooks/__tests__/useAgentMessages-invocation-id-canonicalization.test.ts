/**
 * Identity canonicalization invariant fixture (砚砚 GPT-5.5 2026-04-26 — thread_mogj6kvwp3l80x56 dup bubble).
 *
 * Bug context:
 *   Outer wrapper (msg.invocationId) is the user-turn parent invocation id;
 *   parsed JSON content (parsed.invocationId) is the inner auth child id.
 *   When both arrive, we MUST canonicalize to outer so bubble identity stays
 *   stable across active path + background path. Otherwise active gets
 *   `msg-outer-cat`, bg gets `msg-inner-cat` → dup bubble.
 *
 * Invariant pinned (observable through store writes):
 *   - invocation_created (active + bg)        → setCatInvocation invocationId === msg.invocationId
 *   - invocation_metrics.session_started      → setCatInvocation invocationId === msg.invocationId
 *   - task_progress (active + bg)             → taskProgress.lastInvocationId === msg.invocationId
 *   - web_search / thinking / rich_block (bg) → ensureActiveAssistantMessage uses outer for bubble derivation
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

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
  catInvocations: {} as Record<string, { invocationId?: string }>,

  addMessageToThread: mockAddMessageToThread,
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

const OUTER = 'outer-user-turn-1';
const INNER = 'inner-auth-child-1';

describe('useAgentMessages — outer/inner invocationId canonicalization (砚砚 GPT-5.5 thread_mogj6kvwp3l80x56)', () => {
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
    storeState.catInvocations = {};
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

  // Active path (msg.threadId === currentThreadId) — uses flat setCatInvocation(catId, patch)
  it('active invocation_created: outer wins over inner for setCatInvocation', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-A',
        invocationId: OUTER,
        content: JSON.stringify({ type: 'invocation_created', catId: 'opus', invocationId: INNER }),
        timestamp: 1000,
      });
    });
    const calls = mockSetCatInvocation.mock.calls.filter((c) => c[0] === 'opus' && c[1]?.invocationId);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[1]?.invocationId).toBe(OUTER);
    expect(calls[0]?.[1]?.invocationId).not.toBe(INNER);
  });

  it('active invocation_metrics.session_started: outer wins over inner', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-A',
        invocationId: OUTER,
        content: JSON.stringify({
          type: 'invocation_metrics',
          kind: 'session_started',
          sessionId: 'sess-1',
          invocationId: INNER,
        }),
        timestamp: 1100,
      });
    });
    const calls = mockSetCatInvocation.mock.calls.filter((c) => c[0] === 'opus' && c[1]?.invocationId);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[1]?.invocationId).toBe(OUTER);
  });

  it('active task_progress: lastInvocationId uses outer over inner', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-A',
        invocationId: OUTER,
        content: JSON.stringify({
          type: 'task_progress',
          catId: 'opus',
          invocationId: INNER,
          tasks: [{ id: 't1', label: 'plan', status: 'pending' }],
        }),
        timestamp: 1200,
      });
    });
    const calls = mockSetCatInvocation.mock.calls.filter(
      (c) => c[0] === 'opus' && c[1]?.taskProgress?.lastInvocationId,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[1]?.taskProgress?.lastInvocationId).toBe(OUTER);
  });

  // Background path (msg.threadId !== currentThreadId) — uses thread-aware setThreadCatInvocation(threadId, catId, patch)
  it('bg invocation_created: outer wins over inner for setThreadCatInvocation', () => {
    storeState.currentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-B', // bg path
        invocationId: OUTER,
        content: JSON.stringify({ type: 'invocation_created', catId: 'opus', invocationId: INNER }),
        timestamp: 2000,
      });
    });
    const calls = mockSetThreadCatInvocation.mock.calls.filter(
      (c) => c[0] === 'thread-B' && c[1] === 'opus' && c[2]?.invocationId,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[2]?.invocationId).toBe(OUTER);
    expect(calls[0]?.[2]?.invocationId).not.toBe(INNER);
  });

  it('bg invocation_metrics.session_started: outer wins over inner', () => {
    storeState.currentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-B',
        invocationId: OUTER,
        content: JSON.stringify({
          type: 'invocation_metrics',
          kind: 'session_started',
          sessionId: 'sess-2',
          invocationId: INNER,
        }),
        timestamp: 2100,
      });
    });
    const calls = mockSetThreadCatInvocation.mock.calls.filter(
      (c) => c[0] === 'thread-B' && c[1] === 'opus' && c[2]?.invocationId,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[2]?.invocationId).toBe(OUTER);
  });

  it('bg task_progress: lastInvocationId uses outer over inner', () => {
    storeState.currentThreadId = 'thread-A';
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-B',
        invocationId: OUTER,
        content: JSON.stringify({
          type: 'task_progress',
          catId: 'opus',
          invocationId: INNER,
          tasks: [{ id: 't1', label: 'plan', status: 'pending' }],
        }),
        timestamp: 2200,
      });
    });
    const calls = mockSetThreadCatInvocation.mock.calls.filter(
      (c) => c[0] === 'thread-B' && c[1] === 'opus' && c[2]?.taskProgress?.lastInvocationId,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[2]?.taskProgress?.lastInvocationId).toBe(OUTER);
  });

  // Active path tool/effect events (web_search/thinking/rich_block) — outer-first effectiveInv
  // 砚砚 GPT-5.4 PR #1429 review observation: these 3 paths use `effectiveInv = msg.invocationId ?? parsedInv`
  // for ensureActiveAssistantMessage; bubble id is `msg-{outer}-{cat}` per deriveBubbleId(invocationId, catId).
  it('active web_search: bubble id uses outer (msg-{OUTER}-{cat}) not inner', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-A',
        invocationId: OUTER,
        content: JSON.stringify({ type: 'web_search', invocationId: INNER, count: 1 }),
        timestamp: 1300,
      });
    });
    const expectedId = `msg-${OUTER}-opus`;
    const wrongId = `msg-${INNER}-opus`;
    const addedIds = mockAddMessage.mock.calls.map((c) => c[0]?.id);
    expect(addedIds).toContain(expectedId);
    expect(addedIds).not.toContain(wrongId);
  });

  it('active thinking: bubble id uses outer (msg-{OUTER}-{cat}) not inner', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-A',
        invocationId: OUTER,
        content: JSON.stringify({ type: 'thinking', invocationId: INNER, text: 'planning...' }),
        timestamp: 1400,
      });
    });
    const expectedId = `msg-${OUTER}-opus`;
    const wrongId = `msg-${INNER}-opus`;
    const addedIds = mockAddMessage.mock.calls.map((c) => c[0]?.id);
    expect(addedIds).toContain(expectedId);
    expect(addedIds).not.toContain(wrongId);
  });

  it('active rich_block: bubble id uses outer (msg-{OUTER}-{cat}) not inner', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        threadId: 'thread-A',
        invocationId: OUTER,
        content: JSON.stringify({
          type: 'rich_block',
          invocationId: INNER,
          block: { v: 1, kind: 'card', id: 'block-1', title: 't', body: 'b' },
        }),
        timestamp: 1500,
      });
    });
    const expectedId = `msg-${OUTER}-opus`;
    const wrongId = `msg-${INNER}-opus`;
    const addedIds = mockAddMessage.mock.calls.map((c) => c[0]?.id);
    expect(addedIds).toContain(expectedId);
    expect(addedIds).not.toContain(wrongId);
  });
});
