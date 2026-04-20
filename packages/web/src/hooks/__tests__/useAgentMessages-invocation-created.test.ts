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
