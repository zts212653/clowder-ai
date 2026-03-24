import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureDebug, ensureWindowDebugApi } from '@/debug/invocationEventDebug';
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
    origin?: 'stream' | 'callback';
    extra?: { stream?: { invocationId?: string } };
    timestamp: number;
  }>,
  catInvocations: {} as Record<string, { invocationId?: string }>,
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
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

describe('useAgentMessages placeholder recovery', () => {
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
    configureDebug({ enabled: false });
    delete (window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug;
    storeState.messages = [];
    storeState.catInvocations = {};
    storeState.activeInvocations = {};
    mockAddMessage.mockClear();
    mockAppendRichBlock.mockClear();
    mockSetMessageThinking.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    configureDebug({ enabled: false });
    delete (window as typeof window & { __catCafeDebug?: unknown }).__catCafeDebug;
  });

  it('reuses an existing streaming bubble when thinking arrives after active refs were lost', () => {
    storeState.messages = [
      {
        id: 'msg-live-1',
        type: 'assistant',
        catId: 'opus',
        content: 'partial reply',
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
        catId: 'opus',
        content: JSON.stringify({ type: 'thinking', text: 'still thinking' }),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockSetMessageThinking).toHaveBeenCalledWith('msg-live-1', 'still thinking');
  });

  it('reuses an existing streaming bubble when rich_block arrives after active refs were lost', () => {
    storeState.messages = [
      {
        id: 'msg-live-2',
        type: 'assistant',
        catId: 'opus',
        content: 'partial reply',
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
        catId: 'opus',
        content: JSON.stringify({
          type: 'rich_block',
          block: { id: 'rb-1', kind: 'card', v: 1, title: 'hello', body: 'world' },
        }),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAppendRichBlock).toHaveBeenCalledWith('msg-live-2', expect.objectContaining({ id: 'rb-1' }));
  });

  it('seeds a new stream bubble with invocationId from activeInvocations before invocation_created arrives', () => {
    storeState.activeInvocations = {
      'inv-active-1': { catId: 'opus', mode: 'execute' },
    };

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'tool_use',
        catId: 'opus',
        toolName: 'command_execution',
        toolInput: { command: 'git status' },
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        catId: 'opus',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-active-1' } },
      }),
    );
  });

  it('records bubble timeline when activeInvocations late-binds a new stream bubble', () => {
    configureDebug({ enabled: true });
    ensureWindowDebugApi();
    storeState.activeInvocations = {
      'inv-active-1': { catId: 'opus', mode: 'execute' },
    };

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'tool_use',
        catId: 'opus',
        toolName: 'command_execution',
        toolInput: { command: 'git status' },
      });
    });

    const debugApi = (
      window as typeof window & {
        __catCafeDebug?: { dumpBubbleTimeline?: (options?: { rawThreadId?: boolean }) => string };
      }
    ).__catCafeDebug;
    const dump = JSON.parse(debugApi!.dumpBubbleTimeline!({ rawThreadId: true })) as {
      events: Array<Record<string, unknown>>;
    };

    expect(dump.events).toEqual([
      expect.objectContaining({
        event: 'bubble_lifecycle',
        threadId: 'thread-1',
        action: 'create',
        reason: 'active_late_bind',
        catId: 'opus',
        invocationId: 'inv-active-1',
        origin: 'stream',
      }),
    ]);
    expect(dump.events[0]?.messageId).toEqual(expect.any(String));
  });

  it('recovers when replace hydration swaps the local stream id to a persisted server id mid-stream', () => {
    storeState.catInvocations = { opus: { invocationId: 'inv-live-1' } };

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: 'hello',
        origin: 'stream',
      });
    });

    const localBubble = mockAddMessage.mock.calls.at(-1)?.[0];
    expect(localBubble?.id).toBeTruthy();

    // Hydration replaces the optimistic/local bubble with the persisted server message.
    storeState.messages = [
      {
        id: 'msg-server-1',
        type: 'assistant',
        catId: 'opus',
        content: 'hello',
        origin: 'stream',
        extra: { stream: { invocationId: 'inv-live-1' } },
        isStreaming: false,
        timestamp: Date.now(),
      },
    ];
    mockAppendToMessage.mockClear();
    mockSetStreaming.mockClear();

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'opus',
        content: ' world',
        origin: 'stream',
      });
    });

    expect(mockSetStreaming).toHaveBeenCalledWith('msg-server-1', true);
    expect(mockAppendToMessage).toHaveBeenCalledWith('msg-server-1', ' world');
  });

  it('preserves reply threading metadata on new stream bubbles', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'text',
        catId: 'codex',
        content: '收到，我来处理',
        origin: 'stream',
        replyTo: 'msg-parent-1',
        replyPreview: { senderCatId: 'opus', content: '@缅因猫 帮忙看一下' },
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        catId: 'codex',
        origin: 'stream',
        replyTo: 'msg-parent-1',
        replyPreview: { senderCatId: 'opus', content: '@缅因猫 帮忙看一下' },
      }),
    );
  });
});
