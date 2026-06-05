// F210-H1 hotfix: agy_trajectory_progress system_info must NOT render as a system bubble.
// Bug: backend emits a progress side-channel per trajectory step, but the frontend did not
// recognize the type → it fell through to addMessage/addBackgroundSystemMessage and rendered the
// raw JSON as one system bubble per step (spam). Like liveness_warning/timeout_diagnostics, it
// must be consumed silently (progress display UI is a follow-up).
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
const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({ messages: [] }));
const mockUpdateThreadCatStatus = vi.fn();

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
  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  updateThreadCatStatus: mockUpdateThreadCatStatus,
  currentThreadId: 'thread-1',
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

describe('F210-H1 agy_trajectory_progress frontend', () => {
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
    vi.clearAllMocks();
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not render agy_trajectory_progress as a system message bubble (active path)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'gemini',
        content: JSON.stringify({
          type: 'agy_trajectory_progress',
          idx: 3,
          stepType: 15,
          status: 1,
          label: 'AGY trajectory step #3 (assistant activity) running',
        }),
      });
    });
    // H1: consumed silently — no raw-JSON system bubble spam (one per step).
    expect(mockAddMessage).not.toHaveBeenCalled();
    // H3: 进度累积到 thread 级 catStatusDetails（折叠单行 "AGY working · N steps · latest"），不刷 bubble。
    expect(mockUpdateThreadCatStatus).toHaveBeenCalledWith(
      'thread-1',
      'gemini',
      'streaming',
      expect.stringContaining('AGY working · 4 steps · assistant activity'),
    );
  });

  it('formatAgyProgressDetail: N steps + latest semantic from backend label', async () => {
    const { formatAgyProgressDetail } = await import('@/hooks/system-info-visible');
    expect(formatAgyProgressDetail({ idx: 0, label: 'AGY trajectory step #0 (assistant activity) running' })).toBe(
      'AGY working · 1 step · assistant activity',
    );
    expect(formatAgyProgressDetail({ idx: 6, label: 'AGY trajectory step #6 (operation activity) completed' })).toBe(
      'AGY working · 7 steps · operation activity',
    );
    // unknown step (label 无语义) → fallback 'activity'
    expect(formatAgyProgressDetail({ idx: 2, label: 'AGY trajectory step #2 completed' })).toBe(
      'AGY working · 3 steps · activity',
    );
  });
});
