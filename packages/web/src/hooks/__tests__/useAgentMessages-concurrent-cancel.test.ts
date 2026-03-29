/**
 * F108 P1: Cancelling one cat during concurrent execution must NOT clear other cats' state.
 *
 * Root cause: done(isFinal) handler unconditionally calls setIntentMode(null),
 * clearCatStatuses(), setLoading(false) — even when other cats are still active.
 *
 * Fix: only clear global state when the LAST active invocation ends.
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

  // F108: Two cats actively running
  activeInvocations: {
    'inv-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
    'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
  },
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

describe('F108 P1: concurrent cancel isolation', () => {
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

    // Reset two-cat concurrent state
    storeState.activeInvocations = {
      'inv-opus': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
    };
    storeState.catInvocations = {};
    storeState.messages = [];
    storeState.currentThreadId = 'thread-1';

    // Make removeActiveInvocation actually remove from the record
    mockRemoveActiveInvocation.mockImplementation((invId: string) => {
      const inv = storeState.activeInvocations as Record<string, unknown>;
      delete inv[invId];
    });

    for (const fn of [
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
    ]) {
      fn.mockClear();
    }
    mockGetThreadState.mockImplementation(() => ({ messages: [] }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('done(isFinal) for one cat does NOT clear global state when another cat is still active', () => {
    act(() => root.render(React.createElement(Harness)));

    // Cancel codex — opus is still running
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        isFinal: true,
      });
    });

    // Global state should NOT be cleared — opus is still active
    expect(mockSetIntentMode).not.toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).not.toHaveBeenCalled();
    // setLoading(false) should not be called while another cat runs
    expect(mockSetLoading).not.toHaveBeenCalledWith(false);
  });

  it('done(isFinal) for the LAST cat DOES clear global state', () => {
    // Only one cat active
    storeState.activeInvocations = {
      'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
    };

    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'codex',
        isFinal: true,
      });
    });

    // Now global state SHOULD be cleared — no more active cats
    expect(mockSetIntentMode).toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).toHaveBeenCalled();
    expect(mockSetLoading).toHaveBeenCalledWith(false);
  });

  it('error(isFinal) for one cat does NOT clear global state when another cat is still active', () => {
    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'error',
        catId: 'codex',
        error: 'something broke',
        isFinal: true,
      });
    });

    // Global state should NOT be cleared — opus is still active
    expect(mockSetIntentMode).not.toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).not.toHaveBeenCalled();
  });

  it('error(isFinal) for the LAST cat DOES clear global state (including clearCatStatuses)', () => {
    // Only one cat active
    storeState.activeInvocations = {
      'inv-codex': { catId: 'codex', mode: 'execute', startedAt: Date.now() },
    };

    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'error',
        catId: 'codex',
        error: 'something broke',
        isFinal: true,
      });
    });

    // Now global state SHOULD be cleared — no more active cats
    expect(mockSetIntentMode).toHaveBeenCalledWith(null);
    expect(mockClearCatStatuses).toHaveBeenCalled();
    expect(mockSetLoading).toHaveBeenCalledWith(false);
  });
});
