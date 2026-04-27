/**
 * F173 Phase C Task 2 — pin ChatContainer's `hasActiveInvocation` source-
 * of-truth migration.
 *
 * Before this Task, `hasActiveInvocation` came from flat `chatStore`. After,
 * it comes from `useThreadLiveness(threadId)`. AC-C6's race window:
 * `currentThreadId === thread-a` but the user just navigated to thread-b
 * (props.threadId='thread-b'), and thread-b has an active invocation. The
 * flat slice still mirrors thread-a's quiet state — so the cancel button
 * (driven by hasActiveInvocation) would briefly disappear if ChatContainer
 * read flat.
 *
 * This fixture renders ChatContainer with the race state (flat=quiet,
 * threadStates[threadId]=active) and asserts ChatInput receives
 * `hasActiveInvocation=true` — proving the prop chain is now
 * thread-scoped, not flat.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

const capturedChatInputProps: Array<{ hasActiveInvocation?: boolean; threadId: string }> = [];

function createMockStoreState() {
  return {
    messages: [],
    isLoading: false,
    hasActiveInvocation: false,
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    activeInvocations: {},
    currentThreadId: 'thread-a',
    threadStates: {} as Record<string, unknown>,
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
    threads: [],
  };
}

let storeState = createMockStoreState();

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: ReturnType<typeof createMockStoreState>) => unknown) => {
    return selector ? selector(storeState) : storeState;
  };
  return { useChatStore: hook };
});

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

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

vi.mock('@/hooks/useSendMessage', () => ({ useSendMessage: () => ({ handleSend: vi.fn() }) }));

vi.mock('@/hooks/useAuthorization', () => ({
  useAuthorization: () => ({ pending: [], respond: vi.fn(), handleAuthRequest: vi.fn(), handleAuthResponse: vi.fn() }),
}));

vi.mock('@/hooks/useSplitPaneKeys', () => ({ useSplitPaneKeys: vi.fn() }));

vi.mock('../AuthorizationCard', () => ({ AuthorizationCard: () => null }));
vi.mock('../BootcampListModal', () => ({ BootcampListModal: () => null }));
vi.mock('../BootstrapOrchestrator', () => ({ BootstrapOrchestrator: () => null }));
vi.mock('../CatCafeHub', () => ({ CatCafeHub: () => null }));
vi.mock('../ChatContainerHeader', () => ({ ChatContainerHeader: () => null }));
vi.mock('../ChatInput', () => ({
  ChatInput: (props: { hasActiveInvocation?: boolean; threadId: string }) => {
    capturedChatInputProps.push({ hasActiveInvocation: props.hasActiveInvocation, threadId: props.threadId });
    return null;
  },
}));
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

describe('F173 Phase C Task 2 — ChatContainer.hasActiveInvocation thread-scoped chain', () => {
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
    storeState = createMockStoreState();
    capturedChatInputProps.length = 0;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('AC-C6 race window: flat=false but threadStates[threadId]=true → ChatInput receives hasActiveInvocation=true', () => {
    // The race state: currentThreadId is the *previous* thread (still mirrored
    // in flat as quiet), but ChatContainer.props.threadId is the new thread
    // and that thread has an active invocation in threadStates.
    storeState.currentThreadId = 'thread-a';
    storeState.hasActiveInvocation = false;
    storeState.threadStates = {
      'thread-b': {
        messages: [],
        isLoading: false,
        isLoadingHistory: false,
        hasMore: true,
        hasActiveInvocation: true,
        activeInvocations: { 'inv-b': { catId: 'opus', mode: 'execute' } },
        intentMode: 'execute',
        targetCats: ['opus'],
        catStatuses: { opus: 'streaming' },
        catInvocations: {},
        currentGame: null,
        unreadCount: 0,
        hasUserMention: false,
        lastActivity: 0,
        queue: [],
        queuePaused: false,
        queueFull: false,
        workspaceWorktreeId: null,
        workspaceOpenTabs: [],
        workspaceOpenFilePath: null,
        workspaceOpenFileLine: null,
      },
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-b' }));
    });

    const lastProps = capturedChatInputProps.at(-1);
    expect(lastProps).toBeDefined();
    expect(lastProps?.threadId).toBe('thread-b');
    // The crux: cancel button must not disappear during the race.
    // Pre-Task-2, this would be `false` (read from flat). Post-Task-2, this
    // is `true` (read from threadStates['thread-b'] via useThreadLiveness).
    expect(lastProps?.hasActiveInvocation).toBe(true);
  });

  it('current-thread happy path: flat=true and threadId === currentThreadId → ChatInput receives true', () => {
    storeState.currentThreadId = 'thread-a';
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = { 'inv-a': { catId: 'opus', mode: 'execute' } };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-a' }));
    });

    const lastProps = capturedChatInputProps.at(-1);
    expect(lastProps?.hasActiveInvocation).toBe(true);
  });

  it('quiet thread: both flat and threadStates[threadId] inactive → ChatInput receives false', () => {
    storeState.currentThreadId = 'thread-a';
    storeState.hasActiveInvocation = false;
    storeState.threadStates = {
      'thread-b': {
        messages: [],
        isLoading: false,
        isLoadingHistory: false,
        hasMore: true,
        hasActiveInvocation: false,
        activeInvocations: {},
        intentMode: null,
        targetCats: [],
        catStatuses: {},
        catInvocations: {},
        currentGame: null,
        unreadCount: 0,
        hasUserMention: false,
        lastActivity: 0,
        queue: [],
        queuePaused: false,
        queueFull: false,
        workspaceWorktreeId: null,
        workspaceOpenTabs: [],
        workspaceOpenFilePath: null,
        workspaceOpenFileLine: null,
      },
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-b' }));
    });

    const lastProps = capturedChatInputProps.at(-1);
    expect(lastProps?.hasActiveInvocation).toBe(false);
  });
});
