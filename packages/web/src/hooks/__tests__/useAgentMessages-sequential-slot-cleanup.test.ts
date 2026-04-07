/**
 * Regression: Sequential multi-cat execution must clean up each cat's invocation slot
 * when it finishes, even if isFinal=false (meaning more cats are coming).
 *
 * Root cause: removeActiveInvocation was gated by `if (msg.isFinal)`, so non-final
 * cats (e.g. 缅因猫 finishing before 布偶猫 starts) never had their slots removed,
 * causing ThreadExecutionBar to show "执行中" until F5 refresh.
 *
 * Fix: slot removal runs on every done(), isFinal only gates global state cleanup.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

const mockAddMessage = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockSetStreaming = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockClearAllActiveInvocations = vi.fn();
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockSetMessageUsage = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockRemoveActiveInvocation = vi.fn();

const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({
  messages: [] as Array<{
    id: string;
    type: string;
    catId?: string;
    content: string;
    isStreaming?: boolean;
    timestamp: number;
  }>,
}));

const storeState: Record<string, unknown> = {
  messages: [] as Array<{
    id: string;
    type: string;
    catId?: string;
    content: string;
    isStreaming?: boolean;
    timestamp: number;
  }>,
  addMessage: mockAddMessage,
  appendToMessage: mockAppendToMessage,
  appendToolEvent: mockAppendToolEvent,
  setStreaming: mockSetStreaming,
  setLoading: mockSetLoading,
  setHasActiveInvocation: mockSetHasActiveInvocation,
  clearAllActiveInvocations: mockClearAllActiveInvocations,
  setIntentMode: mockSetIntentMode,
  setCatStatus: mockSetCatStatus,
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: mockSetMessageUsage,
  requestStreamCatchUp: mockRequestStreamCatchUp,
  removeActiveInvocation: mockRemoveActiveInvocation,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-1',

  activeInvocations: {} as Record<string, unknown>,
  catInvocations: {},
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

const allMocks = [
  mockAddMessage,
  mockAppendToMessage,
  mockAppendToolEvent,
  mockSetStreaming,
  mockSetLoading,
  mockSetHasActiveInvocation,
  mockClearAllActiveInvocations,
  mockSetIntentMode,
  mockSetCatStatus,
  mockClearCatStatuses,
  mockSetCatInvocation,
  mockSetMessageUsage,
  mockRemoveActiveInvocation,
  mockRequestStreamCatchUp,
  mockAddMessageToThread,
  mockClearThreadActiveInvocation,
  mockResetThreadInvocationState,
  mockSetThreadMessageStreaming,
  mockGetThreadState,
];

describe('Sequential multi-cat: non-final done removes own slot', () => {
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

    // Sequential scenario: codex runs first, then opus takes over.
    // Both have active invocation slots (codex primary, opus secondary).
    storeState.activeInvocations = {
      'inv-001': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
      'inv-001-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
    };
    storeState.catInvocations = {};
    storeState.messages = [];
    storeState.currentThreadId = 'thread-1';

    mockRemoveActiveInvocation.mockImplementation((invId: string) => {
      const inv = storeState.activeInvocations as Record<string, unknown>;
      delete inv[invId];
    });

    for (const fn of allMocks) {
      fn.mockClear();
    }
    mockGetThreadState.mockImplementation(() => ({ messages: [] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('done(isFinal=false) removes the finishing cat slot from activeInvocations', () => {
    act(() => root.render(React.createElement(Harness)));

    // Codex finishes first with isFinal=false (opus still coming)
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        invocationId: 'inv-001',
        isFinal: false,
      });
    });

    // Codex's primary slot should be removed
    expect(mockRemoveActiveInvocation).toHaveBeenCalledWith('inv-001');
    // Also attempts secondary slot cleanup
    expect(mockRemoveActiveInvocation).toHaveBeenCalledWith('inv-001-codex');

    // Global state must NOT be cleared — isFinal=false means more cats coming
    expect(mockSetLoading).not.toHaveBeenCalledWith(false);
    expect(mockSetIntentMode).not.toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).not.toHaveBeenCalled();
  });

  it('full sequence: codex done(isFinal=false) then opus done(isFinal=true) leaves zero slots', () => {
    act(() => root.render(React.createElement(Harness)));

    // Step 1: Codex finishes (non-final)
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        invocationId: 'inv-001',
        isFinal: false,
      });
    });

    // Codex slot gone, opus slot still present
    const invAfterCodex = storeState.activeInvocations as Record<string, unknown>;
    expect(invAfterCodex['inv-001']).toBeUndefined();
    expect(invAfterCodex['inv-001-opus']).toBeDefined();

    // Step 2: Opus finishes (final)
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        invocationId: 'inv-001',
        isFinal: true,
      });
    });

    // Both slots gone → global state cleared
    const invAfterOpus = storeState.activeInvocations as Record<string, unknown>;
    expect(Object.keys(invAfterOpus).length).toBe(0);
    expect(mockSetLoading).toHaveBeenCalledWith(false);
    expect(mockClearCatStatuses).toHaveBeenCalled();
  });

  it('done(isFinal=false) without invocationId falls back to cat-scoped slot lookup', () => {
    // Setup: only a cat-scoped slot (no invocationId-based slot)
    storeState.activeInvocations = {
      'hydrated-thread-1-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
    };

    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        isFinal: false,
      });
    });

    // Should find and remove the hydrated slot via cat-scoped fallback
    expect(mockRemoveActiveInvocation).toHaveBeenCalledWith('hydrated-thread-1-codex');
  });

  it('non-final done without invocationId must NOT reset hasActiveInvocation when other cats active', () => {
    // P1 from cloud review: codex has no slot but opus is still active.
    // The else-branch fallback must not call setHasActiveInvocation(false).
    storeState.activeInvocations = {
      'inv-001-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
    };

    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        isFinal: false,
      });
    });

    // hasActiveInvocation must stay true — opus is still running
    expect(mockSetHasActiveInvocation).not.toHaveBeenCalledWith(false);
    // Global state must remain untouched
    expect(mockSetLoading).not.toHaveBeenCalledWith(false);
    expect(mockClearCatStatuses).not.toHaveBeenCalled();
  });
});
