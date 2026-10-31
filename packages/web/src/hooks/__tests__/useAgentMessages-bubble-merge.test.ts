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
  lifecycle?: Record<string, unknown>;
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
const mockSetLoading = vi.fn();
const mockSetIntentMode = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn((catId: string, info: Record<string, unknown>) => {
  storeState.catInvocations = {
    ...storeState.catInvocations,
    [catId]: { ...storeState.catInvocations[catId], ...info },
  };
});
const mockRemoveActiveInvocation = vi.fn((invocationId: string) => {
  delete storeState.activeInvocations[invocationId];
});
const mockAddActiveInvocation = vi.fn((invocationId: string, catId: string, mode: string) => {
  storeState.activeInvocations[invocationId] = { catId, mode };
});
const mockAddMessageToThread = vi.fn((threadId: string, msg: TestMessage) => {
  forCurrentThread(threadId, () => {
    if (!storeState.messages.some((m) => m.id === msg.id)) storeState.messages.push(msg);
  });
});
const mockSetThreadMessageStreaming = vi.fn((threadId: string, id: string, streaming: boolean) => {
  forCurrentThread(threadId, () => updateMessage(id, (m) => ({ ...m, isStreaming: streaming })));
});

const storeState = {
  messages: [] as TestMessage[],
  addMessage: mockAddMessage,
  appendToMessage: vi.fn(),
  appendToolEvent: vi.fn(),
  appendRichBlock: vi.fn(),
  setStreaming: vi.fn(),
  setLoading: mockSetLoading,
  setHasActiveInvocation: vi.fn(),
  setIntentMode: mockSetIntentMode,
  setCatStatus: vi.fn(),
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: vi.fn(),
  requestStreamCatchUp: vi.fn(),
  setMessageMetadata: vi.fn(),
  setMessageThinking: vi.fn(),
  patchMessage: vi.fn(),

  getThreadState: vi.fn((threadId: string): { messages: TestMessage[] } => ({
    messages: threadId === storeState.currentThreadId ? storeState.messages : [],
  })),
  addMessageToThread: mockAddMessageToThread,
  appendToThreadMessage: vi.fn(),
  patchThreadMessage: vi.fn(),
  appendToolEventToThread: vi.fn(),
  setThreadMessageThinking: vi.fn(),
  appendRichBlockToThread: vi.fn(),
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
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

/** inv-2's response: stored by the server at dispatch, still streaming. */
function pushInv2Response(id: string) {
  storeState.messages.push({
    id,
    type: 'assistant',
    catId: 'opus',
    content: 'invocation 2 partial',
    isStreaming: true,
    origin: 'stream',
    lifecycle: { kind: 'response', invocationId: 'inv-2', targetId: 'opus', status: 'processing', startedAt: 1000 },
    timestamp: Date.now(),
  });
}

describe('useAgentMessages stale terminal events (Bug-G) + retired projections', () => {
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

  it('ignores retired a2a_handoff projection events', () => {
    mockAddMessage.mockImplementation((msg) => {
      storeState.messages.push(msg);
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'a2a_handoff',
        catId: 'codex',
        content: '布偶猫 → 缅因猫',
        timestamp: 1700000000123,
      });
    });
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
    expect(storeState.messages).toHaveLength(0);
  });

  it('Bug-G stale-done isFinal cleanup (cloud R14): stale done(isFinal=true) must NOT trigger global teardown when activeInvocations is empty', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Reconnect/loss window: a live invocation (inv-2) is streaming but has no
    // tracked slot in activeInvocations (slot registration was lost). A stale
    // done(inv-1, isFinal=true) arrives. `remainingInvocations === 0` fires and,
    // without the stale gate, triggers global teardown:
    //   setLoading(false) + setIntentMode(null) + clearCatStatuses() + clearDoneTimeout
    // That wipes inv-2's execution state mid-run. Fix: gate global teardown on
    // !isStaleDone (mirrors error branch). Staleness is judged from slot /
    // catInvocations truth only: here the direct cat binding says inv-2.
    pushInv2Response('resp-inv2-isfinal-global');
    storeState.catInvocations = { opus: { invocationId: 'inv-2' } }; // contradicts msg=inv-1
    storeState.activeInvocations = {}; // empty — remainingInvocations will be 0

    vi.clearAllMocks();

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        invocationId: 'inv-1',
        messageId: 'resp-inv1',
        isFinal: true,
      });
    });

    // Global teardown MUST be skipped for stale done
    expect(mockSetLoading, 'stale done must not clear global loading').not.toHaveBeenCalledWith(false);
    expect(mockSetIntentMode).not.toHaveBeenCalled();
    expect(mockClearCatStatuses).not.toHaveBeenCalled();
    // The stale done names inv-1's response; inv-2's response keeps streaming.
    expect(storeState.messages.find((m) => m.id === 'resp-inv2-isfinal-global')?.isStreaming).toBe(true);
  });

  it('Bug-G stale-done direct cleanup (cloud R12): stale done(inv-1) still clears matching catInvocations.direct=inv-1', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Preempt window: activeInvocations=inv-2 fresh, catInvocations=inv-1 stale
    // (invocation_created for inv-2 not yet processed). Stale done(inv-1) arrives.
    // R4-R13 gated the catInvocations cleanup inside !isStaleDone, so direct=inv-1
    // survived and later misattributed inv-2's work to inv-1. Fix: clear direct
    // conditionally on direct === msg.invocationId, even when stale.
    const inv2ResponseId = 'resp-inv2-stale-direct-cleanup';
    pushInv2Response(inv2ResponseId);
    storeState.catInvocations = { opus: { invocationId: 'inv-1' } }; // stale direct
    storeState.activeInvocations = { 'inv-2': { catId: 'opus', mode: 'stream' } };

    vi.clearAllMocks();

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        invocationId: 'inv-1',
        messageId: 'resp-inv1',
        isFinal: false,
      });
    });

    // inv-2's response is untouched (the stale done names inv-1's response)
    expect(mockSetThreadMessageStreaming).not.toHaveBeenCalledWith('thread-1', inv2ResponseId, false);
    expect(storeState.messages.find((m) => m.id === inv2ResponseId)?.isStreaming).toBe(true);
    // But direct cleanup runs: setCatInvocation called with invocationId: undefined
    expect(mockSetCatInvocation).toHaveBeenCalledWith('opus', { invocationId: undefined });
    expect(storeState.catInvocations.opus?.invocationId, 'stale direct=inv-1 must be cleared').toBeUndefined();
  });

  it('Bug-G stale-done direct cleanup (cloud R12 guard): stale done(inv-1) must NOT clobber fresh direct=inv-2', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Variant: direct has already moved on to inv-2 (invocation_created for inv-2
    // arrived and set it). Stale done(inv-1) must NOT clear the fresh direct.
    pushInv2Response('resp-inv2-direct-fresh');
    storeState.catInvocations = { opus: { invocationId: 'inv-2' } }; // fresh
    storeState.activeInvocations = { 'inv-2': { catId: 'opus', mode: 'stream' } };

    vi.clearAllMocks();

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        invocationId: 'inv-1',
        messageId: 'resp-inv1',
        isFinal: false,
      });
    });

    // Direct must survive — it's inv-2, not inv-1, so nothing to clear
    expect(mockSetCatInvocation).not.toHaveBeenCalledWith('opus', { invocationId: undefined });
    expect(storeState.catInvocations.opus?.invocationId, 'fresh direct=inv-2 must survive stale done').toBe('inv-2');
  });

  it('Bug-G stale-done guard (砚砚 R10): stale done(inv-1) must NOT delete hydrated slot representing current invocation', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Reconnect hydration scenario: the hydrated slot IS the representation of
    // the current in-flight invocation (server only provided synthetic key).
    // The cat's current invocation is inv-2 (direct binding). Stale done(inv-1) arrives.
    //
    // Bug: unguarded hydrated-orphan cleanup sees `findLatest` return the hydrated
    // key, starts-with 'hydrated-' → removes it → activeInvocations empty →
    // remainingInvocations === 0 → isFinal global cleanup fires → wipes
    // loading/intentMode/catStatuses for inv-2.
    //
    // Fix: hydrated-orphan cleanup gated on !isStaleDone.
    const inv2ResponseId = 'resp-inv2-hydrated-stale-done';
    pushInv2Response(inv2ResponseId);
    storeState.catInvocations = { opus: { invocationId: 'inv-2' } };
    // Only hydrated — represents inv-2's current slot
    storeState.activeInvocations = {
      'hydrated-thread-1-opus': { catId: 'opus', mode: 'stream' },
    };

    vi.clearAllMocks();

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        invocationId: 'inv-1', // stale
        messageId: 'resp-inv1',
        isFinal: true,
      });
    });

    // Hydrated slot must NOT be removed (it represents inv-2, current)
    expect(mockRemoveActiveInvocation).not.toHaveBeenCalledWith('hydrated-thread-1-opus');
    // Global cleanup must NOT fire
    expect(mockSetLoading).not.toHaveBeenCalledWith(false);
    expect(mockSetThreadMessageStreaming).not.toHaveBeenCalledWith('thread-1', inv2ResponseId, false);
    expect(
      storeState.activeInvocations['hydrated-thread-1-opus'],
      'hydrated slot must survive stale done',
    ).toBeDefined();
  });
});
