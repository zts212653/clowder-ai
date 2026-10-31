import React from 'react';
import { vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';
import { ThreadChatRuntimeProvider } from '@/components/thread-chat';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';

export function renderChatContainer(threadId: string) {
  return React.createElement(
    ThreadChatRuntimeProvider,
    { routeThreadId: threadId },
    React.createElement(ChatContainer, { threadId }),
  );
}

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
  viewMode: 'single';
  setViewMode: ReturnType<typeof vi.fn>;
  setCurrentProject: ReturnType<typeof vi.fn>;
  currentProjectPath: string;
  clearUnread: ReturnType<typeof vi.fn>;
  confirmUnreadAck: ReturnType<typeof vi.fn>;
  settleUnreadAck: ReturnType<typeof vi.fn>;
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

export const mockGovRefetch = vi.fn();
export const mockUseAgentHookHealth = vi.fn();
export const mockAgentHookRefresh = vi.fn();
let mockGovernanceStatus = {
  isEmptyDir: false,
  isGitRepo: true,
  gitAvailable: true,
};

export const staleAgentHookHealth = {
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
  updateThreadTitle: vi.fn(),
  viewMode: 'single',
  setViewMode: vi.fn(),
  setCurrentProject: vi.fn(),
  currentProjectPath: '/tmp/demo-project',
  clearUnread: vi.fn(),
  confirmUnreadAck: vi.fn(),
  settleUnreadAck: vi.fn(),
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

export let storeState = makeStoreState();

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: StoreState) => unknown) => {
    const state = storeState;
    return selector ? selector(state) : state;
  };
  return { useChatStore: Object.assign(hook, { getState: () => storeState }) };
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
    messages: storeState.messages,
    handleReadingIntent: vi.fn(),
    jumpToLatest: vi.fn(),
    jumpToMessage: vi.fn(),
    beginUserScroll: vi.fn(),
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
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));
vi.mock('@/hooks/useGovernanceStatus', () => ({
  useGovernanceStatus: () => ({
    status: mockGovernanceStatus,
    refetch: mockGovRefetch,
  }),
}));
vi.mock('@/hooks/useAgentHookHealth', () => ({
  useAgentHookHealth: (options: { enabled?: boolean; projectPath?: string } = {}) => mockUseAgentHookHealth(options),
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
vi.mock('../QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('../ThreadExecutionBar', () => ({ ThreadExecutionBar: () => null }));
vi.mock('../VoteActiveBar', () => ({ VoteActiveBar: () => null }));
vi.mock('../ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
vi.mock('../SplitPaneView', () => ({
  SplitPaneView: () => null,
  SplitPaneChatView: () => null,
}));
vi.mock('../WorkspacePanel', () => ({ WorkspacePanel: () => null }));
vi.mock('../BootstrapOrchestrator', () => ({ BootstrapOrchestrator: () => null }));
vi.mock('../BootcampListModal', () => ({ BootcampListModal: () => null }));
vi.mock('@/components/HubListModal', () => ({ HubListModal: () => null }));
vi.mock('@/components/ProjectSetupCard', () => ({
  ProjectSetupCard: ({ onComplete }: { onComplete: () => void }) =>
    React.createElement('button', { 'data-testid': 'project-setup-complete', onClick: onComplete }, 'complete setup'),
}));
vi.mock('@/components/icons/PawIcon', () => ({ PawIcon: () => null }));
vi.mock('@/components/icons/BootcampIcon', () => ({ BootcampIcon: () => null }));
vi.mock('@/components/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));

export function setMockGovernanceStatus(value: typeof mockGovernanceStatus) {
  mockGovernanceStatus = value;
}

export function resetChatContainerMocks() {
  storeState = makeStoreState();
  useSidebarProjectionStore.setState({ rows: [], pendingThreadCommands: {} });
  mockGovRefetch.mockReset();
  mockAgentHookRefresh.mockReset();
  mockGovernanceStatus = { isEmptyDir: false, isGitRepo: true, gitAvailable: true };
  mockUseAgentHookHealth.mockReset();
  mockUseAgentHookHealth.mockReturnValue({
    health: null,
    error: null,
    syncing: false,
    synced: false,
    syncAttempted: false,
    sync: vi.fn(),
    refresh: mockAgentHookRefresh,
  });
}
