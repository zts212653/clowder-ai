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
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockSetMessageUsage = vi.fn();
const mockRequestStreamCatchUp = vi.fn();

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
    timestamp: number;
  }>,
  addMessage: mockAddMessage,
  appendToMessage: mockAppendToMessage,
  appendToolEvent: mockAppendToolEvent,
  setStreaming: mockSetStreaming,
  setLoading: mockSetLoading,
  setHasActiveInvocation: mockSetHasActiveInvocation,
  setIntentMode: mockSetIntentMode,
  setCatStatus: mockSetCatStatus,
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: mockSetMessageUsage,
  requestStreamCatchUp: mockRequestStreamCatchUp,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
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

describe('useAgentMessages stream catch-up (Bug C safety net)', () => {
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
    storeState.currentThreadId = 'thread-1';
    mockAddMessage.mockClear();
    mockAppendToMessage.mockClear();
    mockAppendToolEvent.mockClear();
    mockSetStreaming.mockClear();
    mockSetLoading.mockClear();
    mockSetHasActiveInvocation.mockClear();
    mockSetIntentMode.mockClear();
    mockSetCatStatus.mockClear();
    mockClearCatStatuses.mockClear();
    mockSetCatInvocation.mockClear();
    mockSetMessageUsage.mockClear();
    mockRequestStreamCatchUp.mockClear();

    mockAddMessageToThread.mockClear();
    mockClearThreadActiveInvocation.mockClear();
    mockResetThreadInvocationState.mockClear();
    mockSetThreadMessageStreaming.mockClear();
    mockGetThreadState.mockClear();
    mockGetThreadState.mockImplementation(() => ({ messages: [] }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('passes threadId to requestStreamCatchUp (P1: thread-scoped)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // system_info sets sawStreamData for this cat, but doesn't create a bubble
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'gemini',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-1' }),
      });
    });

    // done(isFinal) for same cat — stream data was seen but no bubble
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'gemini',
        isFinal: true,
      });
    });

    // P1: must pass threadId so consumer can scope the catch-up
    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
  });

  it('does NOT request catch-up when done(isFinal) has an active bubble', () => {
    storeState.messages = [
      {
        id: 'assistant-msg-1',
        type: 'assistant',
        catId: 'opus',
        content: 'Hello world',
        isStreaming: true,
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
        content: ' more text',
      });
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        isFinal: true,
      });
    });

    expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();
  });

  it('does NOT request catch-up for non-final done', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
      });
    });

    expect(mockRequestStreamCatchUp).not.toHaveBeenCalled();
  });

  it('requests catch-up for callback-only flow when no active bubble (ghost-message)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Simulate a callback text message (real event: type=text, origin=callback)
    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        origin: 'callback',
        content: 'This is a callback response',
      });
    });

    // done(isFinal) arrives — no streaming bubble exists
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        isFinal: true,
      });
    });

    // Ghost-message fix: catch-up fires unconditionally when no active bubble,
    // regardless of whether stream data was seen (sawStreamDataRef guard removed)
    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
  });

  it('requests catch-up when done(isFinal) arrives with no events at all', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Ghost-message scenario: micro-disconnect lost ALL events (stream + callback)
    // Only done(isFinal) arrives
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        isFinal: true,
      });
    });

    // Must trigger catch-up so user sees the response without F5
    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
  });

  it('requests catch-up when stream data was seen but bubble is lost', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    // Simulate stream text arriving (sets sawStreamData flag)
    // then done(isFinal) for a different cat that had no bubble created
    // We need to test the scenario where text arrived but bubble was somehow lost
    // Simplest: send text for catId X, then done(isFinal) for catId X
    // but text will create a bubble... unless we clear activeRefs manually

    // Alternative approach: use system_info (stream chunk type) then done
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-1' }),
      });
    });

    // system_info with invocation_created counts as "saw stream data"
    // Then done(isFinal) with no bubble
    act(() => {
      captured?.handleAgentMessage({
        type: 'done',
        catId: 'opus',
        isFinal: true,
      });
    });

    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
  });
});
