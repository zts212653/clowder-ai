import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockApiFetch = vi.fn(async (_url: string, _opts?: Record<string, unknown>) => ({ ok: true }));

// Mutable store state — mutate between renders to simulate thread switching
let storeState = {
  currentThreadId: 'thread-A',
  messages: [
    {
      id: '0000001772900001-000001-aabbcc01',
      type: 'assistant' as const,
      content: 'hello from A',
      timestamp: Date.now(),
      catId: 'opus',
    },
  ],
};

const baseStore = () => ({
  ...storeState,
  isLoading: false,
  hasActiveInvocation: false,
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  activeInvocations: {},
  addMessage: vi.fn(),
  removeMessage: vi.fn(),
  setLoading: vi.fn(),
  setHasActiveInvocation: vi.fn(),
  setIntentMode: vi.fn(),
  setTargetCats: vi.fn(),
  clearCatStatuses: vi.fn(),
  setCurrentThread: vi.fn(),
  updateThreadTitle: vi.fn(),
  setCurrentGame: vi.fn(),
  currentGame: null,

  viewMode: 'single' as const,
  setViewMode: vi.fn(),
  clearUnread: vi.fn(),
  confirmUnreadAck: vi.fn(),
  armUnreadSuppression: vi.fn(),
  splitPaneThreadIds: [],
  setSplitPaneThreadIds: vi.fn(),
  setSplitPaneTarget: vi.fn(),
  rightPanelMode: null,
  uiThinkingExpandedByDefault: false,
  queue: [],
  queuePaused: false,
  queuePauseReason: null,
  queueFull: false,
  queueFullSource: null,
  threads: [],
});

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: ReturnType<typeof baseStore>) => unknown) => {
    const state = baseStore();
    return selector ? selector(state) : state;
  };
  return { useChatStore: hook };
});

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: string[]) => mockApiFetch(args[0], args[1] as unknown as Record<string, unknown>),
  API_URL: 'http://localhost:3004',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({ tasks: [], addTask: vi.fn(), updateTask: vi.fn(), clearTasks: vi.fn() }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ cancelInvocation: vi.fn(), syncRooms: vi.fn() }),
}));

vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({
    handleAgentMessage: vi.fn(),
    handleStop: vi.fn(),
    resetRefs: vi.fn(),
    resetTimeout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    handleScroll: vi.fn(),
    scrollContainerRef: { current: null },
    messagesEndRef: { current: null },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));

vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn() }),
}));

vi.mock('@/hooks/useAuthorization', () => ({
  useAuthorization: () => ({ pending: [], respond: vi.fn(), handleAuthRequest: vi.fn(), handleAuthResponse: vi.fn() }),
}));

vi.mock('@/hooks/useSplitPaneKeys', () => ({ useSplitPaneKeys: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));

vi.mock('../ChatMessage', () => ({ ChatMessage: () => null }));
vi.mock('../ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../ChatContainerHeader', () => ({ ChatContainerHeader: () => null }));
vi.mock('../ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../RightStatusPanel', () => ({ RightStatusPanel: () => null }));
vi.mock('../ParallelStatusBar', () => ({ ParallelStatusBar: () => null }));
vi.mock('../ThinkingIndicator', () => ({ ThinkingIndicator: () => null }));
vi.mock('../MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('../MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../CatCafeHub', () => ({ CatCafeHub: () => null }));
vi.mock('../SplitPaneView', () => ({ SplitPaneView: () => null }));
vi.mock('../MobileStatusSheet', () => ({ MobileStatusSheet: () => null }));
vi.mock('../QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('@/components/ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
vi.mock('@/components/AuthorizationCard', () => ({ AuthorizationCard: () => null }));
vi.mock('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }));
vi.mock('@/components/icons/PawIcon', () => ({ PawIcon: () => null }));

describe('F069-R5: read ack via POST /read/latest', () => {
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
    mockApiFetch.mockClear();
    storeState = {
      currentThreadId: 'thread-A',
      messages: [
        {
          id: '0000001772900001-000001-aabbcc01',
          type: 'assistant' as const,
          content: 'hello from A',
          timestamp: Date.now(),
          catId: 'opus',
        },
      ],
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('sends POST /read/latest on mount (no message ID needed)', async () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const ackCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(ackCalls.length).toBe(1);
    expect(ackCalls[0][0]).toContain('thread-A');
    expect(ackCalls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('fires new POST /read/latest when threadId changes', async () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    mockApiFetch.mockClear();

    // Switch to thread-B
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-B' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const ackCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(ackCalls.length).toBe(1);
    expect(ackCalls[0][0]).toContain('thread-B');
  });

  it('works regardless of message content (even all-synthetic)', async () => {
    // With R5, ack does not depend on frontend messages at all — server resolves the latest.
    storeState = {
      currentThreadId: 'thread-A',
      messages: [
        { id: 'draft-inv-1', type: 'assistant' as const, content: '...', timestamp: Date.now(), catId: 'opus' },
        {
          id: 'bg-sys-1772900004-opus-1',
          type: 'assistant' as const,
          content: 'info',
          timestamp: Date.now(),
          catId: 'opus',
        },
      ],
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should STILL fire — unlike old approach which skipped when no real IDs were in cache
    const ackCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(ackCalls.length).toBe(1);
  });

  it('re-acks when new messages arrive in the active thread (P1 regression)', async () => {
    // Initial render with 1 message
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should have fired once on mount
    const initialCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(initialCalls.length).toBe(1);
    mockApiFetch.mockClear();

    // Simulate new message arriving (messages.length changes from 1 → 2)
    storeState = {
      currentThreadId: 'thread-A',
      messages: [
        {
          id: '0000001772900001-000001-aabbcc01',
          type: 'assistant' as const,
          content: 'hello from A',
          timestamp: Date.now(),
          catId: 'opus',
        },
        {
          id: '0000001772900002-000002-aabbcc02',
          type: 'assistant' as const,
          content: 'new reply',
          timestamp: Date.now(),
          catId: 'opus',
        },
      ],
    };

    // Re-render with updated store state (simulating store update from socket)
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should fire again because messageCount changed — so switching away after this
    // will have the cursor advanced to the new message
    const newCalls = mockApiFetch.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/read/latest'),
    );
    expect(newCalls.length).toBe(1);
    expect(newCalls[0][0]).toContain('thread-A');
  });
});
