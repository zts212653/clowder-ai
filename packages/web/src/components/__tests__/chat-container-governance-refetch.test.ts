import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';
import { apiFetch } from '@/utils/api-client';

type StoreState = {
  messages: [];
  isLoading: boolean;
  hasActiveInvocation: boolean;
  intentMode: null;
  targetCats: [];
  catStatuses: Record<string, never>;
  catInvocations: Record<string, never>;
  activeInvocations: Record<string, never>;
  addMessage: ReturnType<typeof vi.fn>;
  removeMessage: ReturnType<typeof vi.fn>;
  setLoading: ReturnType<typeof vi.fn>;
  setHasActiveInvocation: ReturnType<typeof vi.fn>;
  setIntentMode: ReturnType<typeof vi.fn>;
  setTargetCats: ReturnType<typeof vi.fn>;
  clearCatStatuses: ReturnType<typeof vi.fn>;
  setCurrentThread: ReturnType<typeof vi.fn>;
  currentThreadId: string;
  updateThreadTitle: ReturnType<typeof vi.fn>;
  setCurrentGame: ReturnType<typeof vi.fn>;
  currentGame: null;
  viewMode: 'single';
  setViewMode: ReturnType<typeof vi.fn>;
  setCurrentProject: ReturnType<typeof vi.fn>;
  currentProjectPath: string;
  clearUnread: ReturnType<typeof vi.fn>;
  confirmUnreadAck: ReturnType<typeof vi.fn>;
  armUnreadSuppression: ReturnType<typeof vi.fn>;
  splitPaneThreadIds: string[];
  setSplitPaneThreadIds: ReturnType<typeof vi.fn>;
  setSplitPaneTarget: ReturnType<typeof vi.fn>;
  showVoteModal: boolean;
  setShowVoteModal: ReturnType<typeof vi.fn>;
  rightPanelMode: null;
  uiThinkingExpandedByDefault: boolean;
  workspaceWorktreeId: string | null;
  queue: [];
  queuePaused: boolean;
  queuePauseReason: null;
  queueFull: boolean;
  queueFullSource: null;
  threads: {
    id: string;
    projectPath: string;
    title: string | null;
    createdBy: string;
    participants: string[];
    lastActiveAt: number;
    createdAt: number;
  }[];
};

const mockGovRefetch = vi.fn();
const mockUseAgentHookHealth = vi.fn();
const mockAgentHookRefresh = vi.fn();

let governanceStatus = {
  ready: true,
  needsBootstrap: false,
  needsConfirmation: false,
  isEmptyDir: false,
  isGitRepo: true,
  gitAvailable: true,
};

const staleAgentHookHealth = {
  status: 'missing',
  targets: [
    {
      name: 'hooks/session-start',
      status: 'missing',
      drifted: true,
      reason: 'target file does not exist',
      targetPath: '/home/user/.claude/hooks/session-start-recall.sh',
      diff: { kind: 'text', message: 'target file is missing' },
    },
  ],
};

const makeStoreState = (): StoreState => ({
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
  setLoading: vi.fn(),
  setHasActiveInvocation: vi.fn(),
  setIntentMode: vi.fn(),
  setTargetCats: vi.fn(),
  clearCatStatuses: vi.fn(),
  setCurrentThread: vi.fn(),
  currentThreadId: 'thread-a',
  updateThreadTitle: vi.fn(),
  setCurrentGame: vi.fn(),
  currentGame: null,
  viewMode: 'single',
  setViewMode: vi.fn(),
  setCurrentProject: vi.fn(),
  currentProjectPath: '/tmp/demo-project',
  clearUnread: vi.fn(),
  confirmUnreadAck: vi.fn(),
  armUnreadSuppression: vi.fn(),
  splitPaneThreadIds: [],
  setSplitPaneThreadIds: vi.fn(),
  setSplitPaneTarget: vi.fn(),
  showVoteModal: false,
  setShowVoteModal: vi.fn(),
  rightPanelMode: null,
  uiThinkingExpandedByDefault: false,
  workspaceWorktreeId: null,
  queue: [],
  queuePaused: false,
  queuePauseReason: null,
  queueFull: false,
  queueFullSource: null,
  threads: [
    {
      id: 'thread-a',
      projectPath: '/tmp/demo-project',
      title: 'Thread A',
      createdBy: 'default-user',
      participants: [],
      lastActiveAt: 1,
      createdAt: 1,
    },
    {
      id: 'thread-b',
      projectPath: '/tmp/demo-project',
      title: 'Thread B',
      createdBy: 'default-user',
      participants: [],
      lastActiveAt: 2,
      createdAt: 2,
    },
  ],
});

let storeState = makeStoreState();

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: StoreState) => unknown) => {
    const state = storeState;
    return selector ? selector(state) : state;
  };
  hook.getState = () => storeState;
  hook.setState = (update: Partial<StoreState> | ((state: StoreState) => Partial<StoreState>)) => {
    storeState = {
      ...storeState,
      ...(typeof update === 'function' ? update(storeState) : update),
    };
  };
  return { useChatStore: hook };
});

vi.mock('@/stores/gameStore', () => {
  const gameState = {
    gameView: null,
    isGameActive: false,
    isNight: false,
    selectedTarget: null,
    godScopeFilter: null,
    myRole: null,
    myRoleIcon: null,
    myActionLabel: null,
    myActionHint: null,
    isGodView: false,
    isDetective: false,
    detectiveBoundName: null,
    godSeats: [],
    godNightSteps: [],
    hasTargetedAction: false,
    altActionName: null,
    overlayMinimized: false,
  };
  const hook = (selector?: (s: typeof gameState) => unknown) => (selector ? selector(gameState) : gameState);
  hook.getState = () => ({ restoreOverlay: vi.fn() });
  return { useGameStore: hook };
});

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3004',
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ threads: [] }) })),
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
    clearDoneTimeout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    handleScroll: vi.fn(),
    scrollContainerRef: { current: null },
    messagesEndRef: { current: document.createElement('div') },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));

vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn(), uploadStatus: null, uploadError: null }),
}));

vi.mock('@/hooks/useAuthorization', () => ({
  useAuthorization: () => ({ pending: [], respond: vi.fn(), handleAuthRequest: vi.fn(), handleAuthResponse: vi.fn() }),
}));

vi.mock('@/hooks/useSplitPaneKeys', () => ({ useSplitPaneKeys: vi.fn() }));
vi.mock('@/hooks/useChatSocketCallbacks', () => ({ useChatSocketCallbacks: () => ({}) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    isLoading: false,
    hasFetched: true,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
    refresh: async () => [],
  }),
}));
vi.mock('@/hooks/usePreviewAutoOpen', () => ({ usePreviewAutoOpen: vi.fn() }));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));
vi.mock('@/hooks/useGovernanceStatus', () => ({
  useGovernanceStatus: () => ({
    status: governanceStatus,
    refetch: mockGovRefetch,
  }),
}));
vi.mock('@/hooks/useAgentHookHealth', () => ({
  useAgentHookHealth: (options: { enabled?: boolean } = {}) => mockUseAgentHookHealth(options),
}));
vi.mock('@/hooks/useIndexState', () => ({
  useIndexState: () => ({
    state: 'idle',
    progress: null,
    summary: null,
    durationMs: null,
    isSnoozed: false,
    startBootstrap: vi.fn(),
    snooze: vi.fn(),
    handleSocketEvent: vi.fn(),
  }),
}));
vi.mock('@/hooks/useVadInterrupt', () => ({ useVadInterrupt: vi.fn() }));
vi.mock('@/hooks/useVoiceAutoPlay', () => ({ useVoiceAutoPlay: vi.fn() }));
vi.mock('@/hooks/useVoiceStream', () => ({ useVoiceStream: vi.fn() }));

vi.mock('../ChatMessage', () => ({ ChatMessage: () => null }));
vi.mock('../ChatInput', () => ({ ChatInput: () => React.createElement('div', { 'data-testid': 'chat-input' }) }));
vi.mock('../ChatContainerHeader', () => ({ ChatContainerHeader: () => null }));
vi.mock('../ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../RightStatusPanel', () => ({ RightStatusPanel: () => null }));
vi.mock('../ParallelStatusBar', () => ({ ParallelStatusBar: () => null }));
vi.mock('../ThinkingIndicator', () => ({ ThinkingIndicator: () => null }));
vi.mock('../MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('../MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../MobileStatusSheet', () => ({ MobileStatusSheet: () => null }));
vi.mock('../QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('../ThreadExecutionBar', () => ({ ThreadExecutionBar: () => null }));
vi.mock('../VoteActiveBar', () => ({ VoteActiveBar: () => null }));
vi.mock('../ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
vi.mock('../SplitPaneView', () => ({ SplitPaneView: () => null }));
vi.mock('../AuthorizationCard', () => ({ AuthorizationCard: () => null }));
vi.mock('../WorkspacePanel', () => ({ WorkspacePanel: () => null }));
vi.mock('../BootstrapOrchestrator', () => ({ BootstrapOrchestrator: () => null }));
vi.mock('../BootcampListModal', () => ({ BootcampListModal: () => null }));
vi.mock('@/components/HubListModal', () => ({ HubListModal: () => null }));
vi.mock('@/components/ProjectSetupCard', () => ({
  ProjectSetupCard: ({ onComplete }: { onComplete: () => void }) =>
    React.createElement('button', { type: 'button', onClick: onComplete }, 'complete project setup'),
}));
vi.mock('@/components/game/GameOverlayConnector', () => ({ GameOverlayConnector: () => null }));
vi.mock('@/components/icons/PawIcon', () => ({ PawIcon: () => null }));
vi.mock('@/components/icons/BootcampIcon', () => ({ BootcampIcon: () => null }));
vi.mock('@/components/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));

describe('ChatContainer governance refetch', () => {
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
    storeState = makeStoreState();
    governanceStatus = {
      ready: true,
      needsBootstrap: false,
      needsConfirmation: false,
      isEmptyDir: false,
      isGitRepo: true,
      gitAvailable: true,
    };
    mockGovRefetch.mockReset();
    mockAgentHookRefresh.mockReset();
    vi.mocked(apiFetch)
      .mockReset()
      .mockImplementation(async () => ({ ok: true, json: async () => ({ threads: [] }) }) as Response);
    mockUseAgentHookHealth.mockReset();
    mockUseAgentHookHealth.mockReturnValue({
      health: null,
      error: null,
      syncing: false,
      synced: false,
      sync: vi.fn(),
      refresh: mockAgentHookRefresh,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not refetch governance status when switching threads within the same project', async () => {
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-a' }));
    });

    expect(mockGovRefetch).not.toHaveBeenCalled();

    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-b' }));
    });

    expect(mockGovRefetch).not.toHaveBeenCalled();
  });

  it('does not render stale agent hook health outside project threads', async () => {
    storeState.currentProjectPath = 'default';
    mockUseAgentHookHealth.mockReturnValue({
      health: staleAgentHookHealth,
      error: null,
      syncing: false,
      synced: false,
      sync: vi.fn(),
    });

    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-a' }));
    });

    expect(mockUseAgentHookHealth).toHaveBeenCalledWith({ enabled: false, projectPath: 'default' });
    expect(container.textContent).not.toContain('Agent 运行 Hook 需要同步');
  });

  it('refreshes governance and agent hook health after project setup completes', async () => {
    governanceStatus = {
      ...governanceStatus,
      ready: false,
      needsBootstrap: true,
    };

    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-a' }));
    });

    const completeButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('complete project setup'),
    );
    if (!completeButton) throw new Error('Missing mocked project setup button');

    await act(async () => {
      completeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockGovRefetch).toHaveBeenCalledTimes(1);
    expect(mockAgentHookRefresh).toHaveBeenCalledTimes(1);
  });

  it('rebinds the active project when thread detail has a newer projectPath than the cached thread list', async () => {
    const reboundProjectPath = '/tmp/rebound-project';
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: async () =>
            path === '/api/threads/thread-a' ? { id: 'thread-a', projectPath: reboundProjectPath } : { threads: [] },
        }) as Response,
    );

    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-a' }));
    });

    expect(storeState.setCurrentProject).toHaveBeenCalledWith(reboundProjectPath);
    expect(storeState.threads.find((thread) => thread.id === 'thread-a')?.projectPath).toBe(reboundProjectPath);
  });

  it('ignores an older thread detail response after a newer reconciliation succeeds', async () => {
    type ThreadPayload = { id: string; projectPath: string };
    let resolveOlder!: (value: ThreadPayload) => void;
    let resolveNewer!: (value: ThreadPayload) => void;
    const older = new Promise<ThreadPayload>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<ThreadPayload>((resolve) => {
      resolveNewer = resolve;
    });
    let threadReads = 0;
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        ({
          ok: true,
          json: () => {
            if (path !== '/api/threads/thread-a') return Promise.resolve({ threads: [] });
            threadReads += 1;
            return threadReads === 1 ? older : newer;
          },
        }) as Response,
    );

    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-a' }));
    });
    storeState.hasActiveInvocation = true;
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-a' }));
    });
    storeState.hasActiveInvocation = false;
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-a' }));
    });

    await act(async () => {
      resolveNewer({ id: 'thread-a', projectPath: '/tmp/newer-project' });
      await newer;
    });
    expect(storeState.threads.find((thread) => thread.id === 'thread-a')?.projectPath).toBe('/tmp/newer-project');

    await act(async () => {
      resolveOlder({ id: 'thread-a', projectPath: '/tmp/older-project' });
      await older;
    });

    expect(storeState.threads.find((thread) => thread.id === 'thread-a')?.projectPath).toBe('/tmp/newer-project');
    expect(storeState.setCurrentProject).not.toHaveBeenCalledWith('/tmp/older-project');
  });
});
