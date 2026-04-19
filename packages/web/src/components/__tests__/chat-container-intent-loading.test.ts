import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetIntentMode = vi.fn();
const mockSetTargetCats = vi.fn();
const mockSetCurrentThread = vi.fn();
const mockClearUnread = vi.fn();
const mockHandleAgentMessage = vi.fn();

let capturedSocketCallbacks: {
  onIntentMode?: (data: { threadId: string; mode: string; targetCats: string[] }) => void;
  onMessage?: (msg: unknown) => void;
} | null = null;

const mockStoreState = () => ({
  messages: [],
  isLoading: false,
  hasActiveInvocation: false,
  intentMode: null,
  targetCats: [],
  catStatuses: {},
  catInvocations: {},
  activeInvocations: {},
  addMessage: vi.fn(),
  removeMessage: vi.fn(),
  setLoading: mockSetLoading,
  setHasActiveInvocation: mockSetHasActiveInvocation,
  setIntentMode: mockSetIntentMode,
  setTargetCats: mockSetTargetCats,
  clearCatStatuses: vi.fn(),
  setCurrentThread: mockSetCurrentThread,
  updateThreadTitle: vi.fn(),
  setCurrentGame: vi.fn(),
  currentGame: null,

  viewMode: 'single' as const,
  setViewMode: vi.fn(),
  clearUnread: mockClearUnread,
  confirmUnreadAck: vi.fn(),
  armUnreadSuppression: vi.fn(),
  splitPaneThreadIds: [],
  setSplitPaneThreadIds: vi.fn(),
  setSplitPaneTarget: vi.fn(),
  threads: [],
});

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: ReturnType<typeof mockStoreState>) => unknown) => {
    const state = mockStoreState();
    return selector ? selector(state) : state;
  };
  return { useChatStore: hook };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({
    tasks: [],
    addTask: vi.fn(),
    updateTask: vi.fn(),
    clearTasks: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: (callbacks: unknown) => {
    capturedSocketCallbacks = callbacks as {
      onIntentMode?: (data: { threadId: string; mode: string; targetCats: string[] }) => void;
      onMessage?: (msg: unknown) => void;
    };
    return { cancelInvocation: vi.fn(), syncRooms: vi.fn() };
  },
}));

vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({
    handleAgentMessage: mockHandleAgentMessage,
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

vi.mock('../AuthorizationCard', () => ({ AuthorizationCard: () => null }));
vi.mock('../BootcampListModal', () => ({ BootcampListModal: () => null }));
vi.mock('../BootstrapOrchestrator', () => ({ BootstrapOrchestrator: () => null }));
vi.mock('../CatCafeHub', () => ({ CatCafeHub: () => null }));
vi.mock('../ChatContainerHeader', () => ({ ChatContainerHeader: () => null }));
vi.mock('../ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../ChatMessage', () => ({ ChatMessage: () => null }));
vi.mock('../game/GameOverlayConnector', () => ({ GameOverlayConnector: () => null }));
vi.mock('../HubListModal', () => ({ HubListModal: () => null }));
vi.mock('../MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('../MobileStatusSheet', () => ({ MobileStatusSheet: () => null }));
vi.mock('../ParallelStatusBar', () => ({ ParallelStatusBar: () => null }));
vi.mock('../ProjectSetupCard', () => ({ ProjectSetupCard: () => null }));
vi.mock('../QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('../RightStatusPanel', () => ({ RightStatusPanel: () => null }));
vi.mock('../ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
vi.mock('../SplitPaneView', () => ({
  SplitPaneView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
vi.mock('../ThinkingIndicator', () => ({ ThinkingIndicator: () => null }));
vi.mock('../ThreadExecutionBar', () => ({ ThreadExecutionBar: () => null }));
vi.mock('../ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../VoteActiveBar', () => ({ VoteActiveBar: () => null }));
vi.mock('../VoteConfigModal', () => ({ VoteConfigModal: () => null }));
vi.mock('../WorkspacePanel', () => ({ WorkspacePanel: () => null }));
vi.mock('../workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));

describe('ChatContainer intent_mode loading lock', () => {
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
    capturedSocketCallbacks = null;
    mockSetLoading.mockClear();
    mockSetHasActiveInvocation.mockClear();
    mockSetIntentMode.mockClear();
    mockSetTargetCats.mockClear();
    mockSetCurrentThread.mockClear();
    mockClearUnread.mockClear();
    mockHandleAgentMessage.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('locks input when current thread receives intent_mode', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(capturedSocketCallbacks?.onIntentMode).toBeTruthy();

    act(() => {
      capturedSocketCallbacks?.onIntentMode?.({
        threadId: 'thread-1',
        mode: 'execute',
        targetCats: ['codex'],
      });
    });

    expect(mockSetLoading).toHaveBeenCalledWith(true);
    expect(mockSetIntentMode).toHaveBeenCalledWith('execute');
    expect(mockSetTargetCats).toHaveBeenCalledWith(['codex']);
  });

  it('sets hasActiveInvocation when current thread receives intent_mode', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    act(() => {
      capturedSocketCallbacks?.onIntentMode?.({
        threadId: 'thread-1',
        mode: 'execute',
        targetCats: ['codex'],
      });
    });

    expect(mockSetHasActiveInvocation).toHaveBeenCalledWith(true);
  });

  // Cross-thread guard has moved to useSocket (dual-pointer guard).
  // ChatContainer's onIntentMode callback only fires for the truly active thread.
  // These tests verify that the callback unconditionally processes whatever it receives
  // (since useSocket guarantees correctness).
  it('processes intent_mode unconditionally (guard is in useSocket, not here)', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-main' }));
    });

    act(() => {
      capturedSocketCallbacks?.onIntentMode?.({
        threadId: 'thread-main',
        mode: 'ideate',
        targetCats: [],
      });
    });

    // Even with empty targetCats, setTargetCats is called to clear any previous value
    expect(mockSetLoading).toHaveBeenCalledWith(true);
    expect(mockSetHasActiveInvocation).toHaveBeenCalledWith(true);
    expect(mockSetIntentMode).toHaveBeenCalledWith('ideate');
    expect(mockSetTargetCats).toHaveBeenCalledWith([]);
  });

  it('does not drop onMessage during thread switch suppression window', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-2' }));
    });

    expect(capturedSocketCallbacks?.onMessage).toBeTruthy();

    capturedSocketCallbacks?.onMessage?.({
      type: 'text',
      catId: 'codex',
      threadId: 'thread-2',
      content: 'hello',
      timestamp: Date.now(),
    });

    expect(mockHandleAgentMessage).toHaveBeenCalledTimes(1);
  });
});
