import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

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
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined, isLoading: false }) }));
vi.mock('@/hooks/usePreviewAutoOpen', () => ({ usePreviewAutoOpen: vi.fn() }));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));
vi.mock('@/hooks/useGovernanceStatus', () => ({
  useGovernanceStatus: () => ({
    status: {
      ready: true,
      needsBootstrap: false,
      needsConfirmation: false,
      isEmptyDir: false,
      isGitRepo: true,
      gitAvailable: true,
    },
    refetch: mockGovRefetch,
  }),
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
vi.mock('../CatCafeHub', () => ({ CatCafeHub: () => null }));
vi.mock('../AuthorizationCard', () => ({ AuthorizationCard: () => null }));
vi.mock('../WorkspacePanel', () => ({ WorkspacePanel: () => null }));
vi.mock('../BootstrapOrchestrator', () => ({ BootstrapOrchestrator: () => null }));
vi.mock('../BootcampListModal', () => ({ BootcampListModal: () => null }));
vi.mock('@/components/HubListModal', () => ({ HubListModal: () => null }));
vi.mock('@/components/ProjectSetupCard', () => ({ ProjectSetupCard: () => null }));
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
    mockGovRefetch.mockReset();
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
});
