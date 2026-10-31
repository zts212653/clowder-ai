/**
 * F173 Phase E (KD-1 handler unification) — single dispatch fixture
 *
 * 砚砚 PR #1421 review P1: useSocket-thread-guard 测试只验 useSocket forward
 * 到 onMessage (vi.fn())，没真实跑 useAgentMessages.handleAgentMessage 的 active vs
 * background 分发。如果 dispatch 实现把 active/bg 路由反了 / background 误写 flat
 * state，旧测试仍会绿。
 *
 * 这里钉真实 dispatch 行为（正文在两条路径上都按 messageId 写入它指名的 response）：
 *   - currentThreadId=A，收 threadId=B 的 msg → background path（thread-scoped status/slot writer 被调）
 *   - currentThreadId=B，收 threadId=B 的 msg → active path（flat setCatStatus 被调）
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

const mockAddMessageToThread = vi.fn();
const mockSetThreadLoading = vi.fn();
const mockSetThreadHasActiveInvocation = vi.fn();
const mockSetThreadCatInvocation = vi.fn();
const mockAddThreadActiveInvocation = vi.fn();
const mockRemoveThreadActiveInvocation = vi.fn();
const mockUpdateThreadCatStatus = vi.fn();
const mockBatchStreamChunkUpdate = vi.fn();
const mockPatchThreadMessage = vi.fn();
const mockReplaceThreadTargetCats = vi.fn();
const mockRemoveThreadMessage = vi.fn();
const mockAppendToThreadMessage = vi.fn();
const mockAppendToolEventToThread = vi.fn();
const mockAppendRichBlockToThread = vi.fn();
const mockSetThreadMessageMetadata = vi.fn();
const mockSetThreadMessageUsage = vi.fn();
const mockSetThreadMessageThinking = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockThreadState = {
  messages: [] as Array<{ id: string; type: string; catId?: string; content: string; timestamp: number }>,
  isLoading: false,
  hasActiveInvocation: false,
  activeInvocations: {} as Record<string, { catId: string; mode: string }>,
  catInvocations: {} as Record<string, { invocationId?: string }>,
  catStatuses: {} as Record<string, string>,
};
const mockGetThreadState = vi.fn(() => mockThreadState);

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

  // Thread-scoped: background status/slot writers + named-message body writes
  // (hooks/named-message-writer.ts), which the active and background paths share.
  addMessageToThread: mockAddMessageToThread,
  incrementUnread: vi.fn(),
  setThreadLoading: mockSetThreadLoading,
  setThreadHasActiveInvocation: mockSetThreadHasActiveInvocation,
  setThreadCatInvocation: mockSetThreadCatInvocation,
  addThreadActiveInvocation: mockAddThreadActiveInvocation,
  removeThreadActiveInvocation: mockRemoveThreadActiveInvocation,
  updateThreadCatStatus: mockUpdateThreadCatStatus,
  batchStreamChunkUpdate: mockBatchStreamChunkUpdate,
  patchThreadMessage: mockPatchThreadMessage,
  replaceThreadTargetCats: mockReplaceThreadTargetCats,
  removeThreadMessage: mockRemoveThreadMessage,
  appendToThreadMessage: mockAppendToThreadMessage,
  appendToolEventToThread: mockAppendToolEventToThread,
  appendRichBlockToThread: mockAppendRichBlockToThread,
  setThreadMessageMetadata: mockSetThreadMessageMetadata,
  setThreadMessageUsage: mockSetThreadMessageUsage,
  setThreadMessageThinking: mockSetThreadMessageThinking,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-active', // 默认 active = thread-active
};

vi.mock('@/stores/chatStore', () => {
  const useChatStoreMock = Object.assign(() => storeState, { getState: () => storeState });
  return { useChatStore: useChatStoreMock };
});

const mockAddToast = vi.fn();
vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({ addToast: mockAddToast }),
  },
}));

let captured: ReturnType<typeof useAgentMessages> | undefined;
function Harness() {
  captured = useAgentMessages();
  return null;
}

describe('useAgentMessages — F173 Phase E single dispatch (KD-1 handler unification)', () => {
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
    storeState.currentThreadId = 'thread-active';
    storeState.messages = [];
    mockThreadState.messages = [];
    mockThreadState.isLoading = false;
    mockThreadState.hasActiveInvocation = false;
    mockThreadState.activeInvocations = {};
    mockThreadState.catInvocations = {};
    mockThreadState.catStatuses = {};
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  describe('background dispatch: currentThreadId !== msg.threadId', () => {
    it('routes msg with threadId !== currentThreadId to background thread-scoped writers (砚砚 P1)', () => {
      storeState.currentThreadId = 'thread-active';
      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          catId: 'opus',
          threadId: 'thread-background', // 不同于 currentThreadId
          content: 'hello from bg thread',
          invocationId: 'inv-bg',
          origin: 'stream',
          messageId: 'resp-1',
          timestamp: Date.now(),
        });
      });

      // Background body writes go through the thread-scoped writer into the named response:
      // created under the server id in thread-background, then appended. No client-derived
      // bubble id (`msg-{inv}-{cat}`) is ever created.
      expect(mockAddMessageToThread).toHaveBeenCalledWith(
        'thread-background',
        expect.objectContaining({ id: 'resp-1', type: 'assistant', catId: 'opus' }),
      );
      expect(mockAddMessageToThread.mock.calls.every((c) => (c[1] as { id?: string }).id === 'resp-1')).toBe(true);
      expect(mockAppendToThreadMessage).toHaveBeenCalledWith('thread-background', 'resp-1', 'hello from bg thread');
      expect(mockAddThreadActiveInvocation).toHaveBeenCalledWith('thread-background', 'inv-bg', 'opus', 'execute');
      expect(mockUpdateThreadCatStatus).toHaveBeenCalledWith('thread-background', 'opus', 'streaming');

      // active path writers 必须 NOT 被调（防止 background 误写 flat state）
      expect(mockAddMessage).not.toHaveBeenCalled();
      expect(mockSetCatStatus).not.toHaveBeenCalled();
    });

    it('routes msg with no threadId to active path (defensive legacy fallback)', () => {
      storeState.currentThreadId = 'thread-active';
      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        // No threadId — legacy malformed payload, falls to active path
        captured?.handleAgentMessage({
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'liveness_warning', __livenessWarning: true, level: 'alive_but_silent' }),
        });
      });

      // background must NOT run (no threadId, falls to active legacy)
      expect(mockAddMessageToThread).not.toHaveBeenCalled();
      // active path runs (setCatStatus from liveness_warning processing)
      expect(mockSetCatStatus).toHaveBeenCalledWith('opus', 'alive_but_silent');
    });
  });

  describe('active dispatch: currentThreadId === msg.threadId', () => {
    it('routes msg with threadId === currentThreadId to active path (NOT bg)', () => {
      storeState.currentThreadId = 'thread-active';
      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'text',
          catId: 'opus',
          threadId: 'thread-active', // same as current
          content: 'hello from active thread',
          origin: 'stream',
          messageId: 'resp-1',
          timestamp: Date.now(),
        });
      });

      // background path NOT called (its thread-scoped status writer stays untouched)
      expect(mockUpdateThreadCatStatus).not.toHaveBeenCalled();
      // active path must update cat status (text event → 'streaming')
      expect(mockSetCatStatus).toHaveBeenCalledWith('opus', 'streaming');
      // the body lands in the named response of the open thread
      expect(mockAddMessageToThread).toHaveBeenCalledWith(
        'thread-active',
        expect.objectContaining({ id: 'resp-1', type: 'assistant', catId: 'opus' }),
      );
    });

    it('projects a typed context briefing into the active timeline', () => {
      const now = Date.now();
      storeState.currentThreadId = 'thread-active';
      act(() => {
        root.render(React.createElement(Harness));
      });

      act(() => {
        captured?.handleAgentMessage({
          type: 'system_info',
          catId: 'opus',
          threadId: 'thread-active',
          content: JSON.stringify({
            type: 'context_briefing',
            storedMessage: {
              id: 'briefing-active-1',
              content: '看到 13 条 · 省略 8 条',
              origin: 'briefing',
              timestamp: now,
              extra: {
                systemKind: 'context_briefing',
                rich: {
                  v: 1,
                  blocks: [{ id: 'briefing-card-active-1', kind: 'card', v: 1, title: '看到 13 条 · 省略 8 条' }],
                },
              },
            },
          }),
          timestamp: now,
        });
      });

      expect(mockAddMessage).toHaveBeenCalledWith({
        id: 'briefing-active-1',
        type: 'system',
        content: '看到 13 条 · 省略 8 条',
        origin: 'briefing',
        timestamp: now,
        extra: {
          systemKind: 'context_briefing',
          rich: {
            v: 1,
            blocks: [{ id: 'briefing-card-active-1', kind: 'card', v: 1, title: '看到 13 条 · 省略 8 条' }],
          },
        },
      });
      expect(mockAddMessageToThread).not.toHaveBeenCalled();
    });
  });
});
