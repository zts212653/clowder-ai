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
  viewMode: 'single' | 'split';
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
  threads: [];
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
  setCurrentGame: vi.fn(),
  currentGame: null,
  viewMode: 'single',
  setViewMode: vi.fn(),
  setCurrentProject: vi.fn(),
  currentProjectPath: 'default',
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
  threads: [],
});

let storeState = makeStoreState();
const resizeObserverInstances: MockResizeObserver[] = [];

class MockResizeObserver {
  observe = vi.fn<(target: Element) => void>();
  disconnect = vi.fn();
  unobserve = vi.fn();

  constructor(_callback: ResizeObserverCallback) {
    void _callback;
    resizeObserverInstances.push(this);
  }
}

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
  const hook = (selector?: (s: typeof gameState) => unknown) => {
    return selector ? selector(gameState) : gameState;
  };
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
  useGovernanceStatus: () => ({ status: null, refetch: vi.fn() }),
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
vi.mock('../ChatInput', () => ({
  ChatInput: () => React.createElement('div', { 'data-testid': 'chat-input' }),
}));
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
vi.mock('../QueuePanel', () => ({
  QueuePanel: () => React.createElement('div', { 'data-testid': 'queue-panel' }),
}));
vi.mock('../ThreadExecutionBar', () => ({
  ThreadExecutionBar: () => React.createElement('div', { 'data-testid': 'execution-bar' }),
}));
vi.mock('../VoteActiveBar', () => ({
  VoteActiveBar: () => React.createElement('div', { 'data-testid': 'vote-bar' }),
}));
vi.mock('../ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
vi.mock('../SplitPaneView', () => ({
  SplitPaneView: () => React.createElement('div', { 'data-testid': 'split-view' }),
}));
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

describe('ChatContainer bottom chrome observer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof globalThis.ResizeObserver;

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
    resizeObserverInstances.length = 0;
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof globalThis.ResizeObserver;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width: 768px'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('re-observes the new bottom chrome after split view toggles back to single', async () => {
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    const firstBottomChrome = container.querySelector('[data-testid="chat-input"]')?.parentElement;
    expect(firstBottomChrome).toBeTruthy();
    expect(resizeObserverInstances).toHaveLength(1);
    expect(resizeObserverInstances[0]?.observe.mock.calls[0]?.[0]).toBe(firstBottomChrome);

    storeState = { ...storeState, viewMode: 'split' };
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });
    expect(container.querySelector('[data-testid="split-view"]')).toBeTruthy();
    expect(resizeObserverInstances[0]?.disconnect).toHaveBeenCalledTimes(1);

    storeState = { ...storeState, viewMode: 'single' };
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    const secondBottomChrome = container.querySelector('[data-testid="chat-input"]')?.parentElement;
    expect(secondBottomChrome).toBeTruthy();
    expect(secondBottomChrome).not.toBe(firstBottomChrome);
    expect(resizeObserverInstances).toHaveLength(2);
    expect(resizeObserverInstances[1]?.observe.mock.calls[0]?.[0]).toBe(secondBottomChrome);
  });
});
