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
const mockSetMessageStreamInvocation = vi.fn();
const mockRemoveActiveInvocation = vi.fn();
const mockAddActiveInvocation = vi.fn();
const mockReplaceThreadTargetCats = vi.fn();

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
    extra?: { stream?: { invocationId?: string } };
    timestamp: number;
  }>,
  catInvocations: {
    codex: {
      invocationId: 'inv-old',
      taskProgress: {
        tasks: [{ id: 'task-1', subject: 'old plan', status: 'in_progress' }],
        lastUpdate: Date.now() - 60_000,
        snapshotStatus: 'running' as const,
      },
    },
  } as Record<string, unknown>,
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
  removeActiveInvocation: mockRemoveActiveInvocation,
  addActiveInvocation: mockAddActiveInvocation,
  replaceThreadTargetCats: mockReplaceThreadTargetCats,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-1',
  targetCats: ['codex'],
  activeInvocations: {} as Record<string, { catId: string; mode: string; startedAt?: number }>,
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

describe('useAgentMessages system_info invocation_created', () => {
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
    storeState.targetCats = ['codex'];
    storeState.activeInvocations = {};
    mockRemoveActiveInvocation.mockImplementation((invocationId: string) => {
      delete storeState.activeInvocations[invocationId];
    });
    mockAddActiveInvocation.mockImplementation(
      (invocationId: string, catId: string, mode: string, startedAt?: number) => {
        storeState.activeInvocations[invocationId] = { catId, mode, ...(startedAt ? { startedAt } : {}) };
      },
    );
    mockReplaceThreadTargetCats.mockImplementation((_threadId: string, cats: string[]) => {
      storeState.targetCats = [...cats];
    });
    mockAddMessage.mockClear();
    mockSetCatInvocation.mockClear();
    mockSetMessageStreamInvocation.mockClear();
    mockRemoveActiveInvocation.mockClear();
    mockAddActiveInvocation.mockClear();
    mockReplaceThreadTargetCats.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('consumes invocation_created and resets stale task progress', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-new-1' }),
      });
    });

    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        invocationId: 'inv-new-1',
        taskProgress: expect.objectContaining({
          tasks: [],
          snapshotStatus: 'running',
          lastInvocationId: 'inv-new-1',
        }),
      }),
    );

    const rawJsonBubble = mockAddMessage.mock.calls.find(
      (call) => call[0]?.type === 'system' && String(call[0]?.content).includes('"invocation_created"'),
    );
    expect(rawJsonBubble).toBeUndefined();
  });

  it('binds stream invocation identity onto an existing placeholder bubble when invocation_created arrives late', () => {
    storeState.messages = [
      {
        id: 'msg-live-1',
        type: 'assistant',
        catId: 'codex',
        content: 'partial chunk',
        isStreaming: true,
        timestamp: Date.now(),
      },
    ];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-new-2' }),
      });
    });

    expect(mockSetMessageStreamInvocation).toHaveBeenCalledWith('msg-live-1', 'inv-new-2');
  });

  it('updates activeRefs to the rebound bubble even when it was NOT the prior activeRef target (cloud P1#9, PR#1352)', () => {
    // Cloud Codex P1#9: when invocation_created rebinds an unbound placeholder that's
    // NOT the current activeRefs target, activeRefs stays pointing at the OLD bubble.
    // Subsequent invocationless events would reuse the stale ref → cross-invocation
    // merge/ghost. Fix: always update activeRefs to the rebound bubble.
    //
    // Verification: after invocation_created with two unbound bubbles, an invocationless
    // tool_use must target the NEWEST (rebound) bubble's id, not the older one.
    const olderUnboundId = 'msg-older-unbound';
    const newerUnboundId = 'msg-newer-unbound';
    const replaceCalls: Array<[string, string]> = [];
    (storeState as Record<string, unknown>).replaceMessageId = vi.fn((from: string, to: string) => {
      replaceCalls.push([from, to]);
      storeState.messages = storeState.messages.map((m) => (m.id === from ? { ...m, id: to } : m));
    });
    storeState.messages = [
      {
        id: olderUnboundId,
        type: 'assistant',
        catId: 'codex',
        content: 'older unbound',
        isStreaming: true,
        origin: 'stream',
        timestamp: Date.now() - 30_000,
      } as (typeof storeState.messages)[number],
      {
        id: newerUnboundId,
        type: 'assistant',
        catId: 'codex',
        content: 'newer unbound',
        isStreaming: true,
        origin: 'stream',
        timestamp: Date.now(),
      } as (typeof storeState.messages)[number],
    ];

    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-rebind' }),
      });
    });

    // Rebind targeted the NEWEST (newerUnboundId).
    const reboundCall = replaceCalls.find(([from]) => from === newerUnboundId);
    expect(reboundCall, 'rebind must target newest unbound bubble').toBeTruthy();
    const reboundId = reboundCall![1];

    // Invocationless follow-up must hit the REBOUND id, NOT the older bubble.
    mockAppendToolEvent.mockClear();
    act(() => {
      captured?.handleAgentMessage({
        type: 'tool_use',
        catId: 'codex',
        toolName: 'follow_up',
        toolInput: {},
      });
    });
    expect(
      mockAppendToolEvent.mock.calls.some((c: unknown[]) => c[0] === olderUnboundId),
      'follow-up must NOT target older bubble',
    ).toBe(false);
    expect(
      mockAppendToolEvent.mock.calls.some((c: unknown[]) => c[0] === reboundId),
      'follow-up should target rebound (live) bubble',
    ).toBe(true);
  });

  it('rebinds the NEWEST unbound stream bubble (cloud P1, PR#1352) — not the oldest', () => {
    // Cloud Codex P1 on PR#1352: invocation_created scanned messagesSnapshot
    // oldest → newest and captured the FIRST unbound placeholder. Under reconnect/
    // hydration, multiple unbound streaming bubbles can exist for the same cat —
    // the historical one would get bound, leaving the active live bubble unbound
    // and reintroducing the ghost/split.
    //
    // Fix: prefer activeRefs target if unbound; else iterate newest → oldest.
    const oldStaleId = 'msg-stale-historical-unbound';
    const liveActiveId = 'msg-live-active-unbound';
    const replaceCalls: Array<[string, string]> = [];
    mockSetMessageStreamInvocation.mockImplementation(() => {
      // No-op for this test's purpose (we assert via mockSetMessageStreamInvocation calls).
    });
    // Track replaceMessageId calls (id transition for unbound → deterministic).
    const replaceFn = vi.fn((from: string, to: string) => {
      replaceCalls.push([from, to]);
    });
    // Inject replaceMessageId into store — this test's storeState doesn't have it
    // wired by default, so add it locally.
    (storeState as Record<string, unknown>).replaceMessageId = replaceFn;

    storeState.messages = [
      {
        id: oldStaleId,
        type: 'assistant',
        catId: 'codex',
        content: 'historical unbound bubble (e.g. survived hydration)',
        isStreaming: true,
        origin: 'stream',
        timestamp: Date.now() - 60_000,
      } as (typeof storeState.messages)[number],
      {
        id: liveActiveId,
        type: 'assistant',
        catId: 'codex',
        content: 'live active bubble for the new invocation',
        isStreaming: true,
        origin: 'stream',
        timestamp: Date.now(),
      } as (typeof storeState.messages)[number],
    ];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-fresh' }),
      });
    });

    // The LIVE bubble (newest unbound) must get the invocationId binding.
    // The historical stale bubble must NOT be picked up.
    const bindCalls = mockSetMessageStreamInvocation.mock.calls.filter((c) => c[1] === 'inv-fresh');
    expect(bindCalls, 'exactly one bubble should be bound to inv-fresh').toHaveLength(1);
    const boundOriginalId = bindCalls[0][0];
    // boundOriginalId might be liveActiveId itself (if deterministic id derivation hit
    // fallback) OR the deterministic form. We assert via the upstream replace path:
    // either replaceMessageId was called from liveActiveId → deterministic, OR the
    // stream invocation was set directly on liveActiveId.
    const replacedFromLive = replaceCalls.some(([from]) => from === liveActiveId);
    const directBindOnLive = boundOriginalId === liveActiveId;
    expect(replacedFromLive || directBindOnLive, 'live (newest) bubble must be the rebind target').toBe(true);
    // Critically, the historical stale one is NOT touched.
    const replacedFromStale = replaceCalls.some(([from]) => from === oldStaleId);
    expect(replacedFromStale, 'historical stale bubble must NOT be replaced').toBe(false);
    expect(
      mockSetMessageStreamInvocation.mock.calls.some(([id]) => id === oldStaleId),
      'historical stale bubble must NOT receive invocationId binding',
    ).toBe(false);
  });

  it('migrates the active slot and displayed target during sequential handoff recovery', () => {
    storeState.activeInvocations = {
      'inv-root': { catId: 'codex', mode: 'execute', startedAt: 123456 },
    };
    storeState.targetCats = ['codex'];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-root' }),
      });
    });

    expect(mockRemoveActiveInvocation).toHaveBeenCalledWith('inv-root');
    expect(mockAddActiveInvocation).toHaveBeenCalledWith('inv-root', 'opus', 'execute', 123456);
    expect(mockReplaceThreadTargetCats).toHaveBeenCalledWith('thread-1', ['opus']);
    expect(storeState.activeInvocations['inv-root']).toEqual({
      catId: 'opus',
      mode: 'execute',
      startedAt: 123456,
    });
    expect(storeState.targetCats).toEqual(['opus']);
  });

  it('does not rewrite slots for cats that already have an explicit parallel slot', () => {
    storeState.activeInvocations = {
      'inv-root': { catId: 'opus', mode: 'execute', startedAt: 123456 },
      'inv-root-codex': { catId: 'codex', mode: 'execute', startedAt: 123457 },
    };
    storeState.targetCats = ['opus', 'codex'];

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-root' }),
      });
    });

    expect(mockRemoveActiveInvocation).not.toHaveBeenCalled();
    expect(mockAddActiveInvocation).not.toHaveBeenCalled();
    expect(mockReplaceThreadTargetCats).not.toHaveBeenCalled();
    expect(storeState.activeInvocations).toEqual({
      'inv-root': { catId: 'opus', mode: 'execute', startedAt: 123456 },
      'inv-root-codex': { catId: 'codex', mode: 'execute', startedAt: 123457 },
    });
  });
});
