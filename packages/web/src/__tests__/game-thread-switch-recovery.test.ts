/**
 * F101: Game state recovery on thread switch — integration test.
 *
 * Renders the REAL ChatContainer (with heavy deps mocked out) and verifies that
 * threadId changes trigger reconnectGame(threadId) through the actual useEffect.
 *
 * If someone removes the reconnectGame(threadId) call from ChatContainer,
 * these tests FAIL — unlike the previous unit-only version that was "fake green".
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

// ── The spy we want to verify ──
const mockReconnectGame = vi.fn<(threadId: string) => Promise<void>>(async () => {});

vi.mock('@/hooks/useGameReconnect', () => ({
  reconnectGame: (...args: [string]) => mockReconnectGame(...args),
}));

// ── Chat store (minimal) ──
vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      messages: [],
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      setCurrentThread: vi.fn(),
      viewMode: 'single',
      setViewMode: vi.fn(),
      clearUnread: vi.fn(),
      confirmUnreadAck: vi.fn(),
      armUnreadSuppression: vi.fn(),
      rightPanelMode: null,
      uiThinkingExpandedByDefault: false,
      queue: [],
      splitPaneThreadIds: [],
      setSplitPaneThreadIds: vi.fn(),
      setSplitPaneTarget: vi.fn(),
      showVoteModal: false,
      setShowVoteModal: vi.fn(),
      addMessage: vi.fn(),
      threads: [],
      setCurrentProject: vi.fn(),
      workspaceWorktreeId: null,
    };
    return selector ? selector(state) : state;
  };
  return { useChatStore: hook };
});

// ── Game store (real-ish, returns safe defaults) ──
vi.mock('@/stores/gameStore', () => ({
  useGameStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      gameView: null,
      isGameActive: false,
      isNight: false,
      selectedTarget: null,
      godScopeFilter: 'all',
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
      mySeatId: null,
      currentActionName: null,
      getState: () => state,
      clearGame: vi.fn(),
      setSelectedTarget: vi.fn(),
      setGodScopeFilter: vi.fn(),
      setGameView: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({ tasks: [], addTask: vi.fn(), updateTask: vi.fn(), clearTasks: vi.fn() }),
}));

// ── Hooks (stubbed out) ──
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true })),
  API_URL: 'http://localhost:3004',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
    messagesEndRef: { current: null },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn(), uploadStatus: null, uploadError: null }),
}));
vi.mock('@/hooks/useAuthorization', () => ({
  useAuthorization: () => ({
    pending: [],
    respond: vi.fn(),
    handleAuthRequest: vi.fn(),
    handleAuthResponse: vi.fn(),
  }),
}));
vi.mock('@/hooks/useSplitPaneKeys', () => ({ useSplitPaneKeys: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/hooks/useVoiceAutoPlay', () => ({ useVoiceAutoPlay: vi.fn() }));
vi.mock('@/hooks/usePreviewAutoOpen', () => ({ usePreviewAutoOpen: vi.fn() }));
vi.mock('@/hooks/usePersistedState', () => ({
  usePersistedState: (key: string, defaultVal: unknown) => [defaultVal, vi.fn(), vi.fn()],
}));
vi.mock('@/hooks/useChatSocketCallbacks', () => ({
  useChatSocketCallbacks: () => ({}),
}));
vi.mock('@/hooks/useGameApi', () => ({
  abortGame: vi.fn(),
  godAction: vi.fn(),
  submitAction: vi.fn(),
}));
vi.mock('@/utils/scrollRecomputeSignal', () => ({
  computeScrollRecomputeSignal: () => '',
}));
vi.mock('@/utils/userId', () => ({
  getUserId: () => 'test-user',
}));

// ── Components (stubbed to null) ──
vi.mock('@/components/ChatMessage', () => ({ ChatMessage: () => null }));
vi.mock('@/components/ChatInput', () => ({ ChatInput: () => null }));
vi.mock('@/components/ChatContainerHeader', () => ({ ChatContainerHeader: () => null }));
vi.mock('@/components/ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('@/components/RightStatusPanel', () => ({ RightStatusPanel: () => null }));
vi.mock('@/components/ParallelStatusBar', () => ({ ParallelStatusBar: () => null }));
vi.mock('@/components/ThinkingIndicator', () => ({ ThinkingIndicator: () => null }));
vi.mock('@/components/A2ACollapsible', () => ({ A2ACollapsible: () => null }));
vi.mock('@/components/MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('@/components/MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/CatCafeHub', () => ({ CatCafeHub: () => null }));
vi.mock('@/components/SplitPaneView', () => ({ SplitPaneView: () => null }));
vi.mock('@/components/MobileStatusSheet', () => ({ MobileStatusSheet: () => null }));
vi.mock('@/components/QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('@/components/ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
vi.mock('@/components/AuthorizationCard', () => ({ AuthorizationCard: () => null }));
vi.mock('@/components/WorkspacePanel', () => ({ WorkspacePanel: () => null }));
vi.mock('@/components/VoteActiveBar', () => ({ VoteActiveBar: () => null }));
vi.mock('@/components/VoteConfigModal', () => ({ VoteConfigModal: () => null }));
vi.mock('@/components/BootcampListModal', () => ({ BootcampListModal: () => null }));
vi.mock('@/components/ThreadExecutionBar', () => ({ ThreadExecutionBar: () => null }));
vi.mock('@/components/icons/PawIcon', () => ({ PawIcon: () => null }));
vi.mock('@/components/icons/BootcampIcon', () => ({ BootcampIcon: () => null }));
vi.mock('@/components/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));
vi.mock('@/components/game/GameOverlayConnector', () => ({ GameOverlayConnector: () => null }));

// ── Test suite ──

describe('F101: ChatContainer calls reconnectGame on thread switch (integration)', () => {
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
    mockReconnectGame.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('AC1: calls reconnectGame(threadId) on mount', async () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-game-1' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockReconnectGame).toHaveBeenCalledWith('thread-game-1');
  });

  it('AC2: calls reconnectGame with NEW threadId when thread switches', async () => {
    // Initial mount on thread-A
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-A' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockReconnectGame).toHaveBeenCalledWith('thread-A');
    mockReconnectGame.mockClear();

    // Switch to thread-B
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-B' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockReconnectGame).toHaveBeenCalledWith('thread-B');
  });

  it('AC3: full round-trip — game thread → normal → back to game thread', async () => {
    const GAME_THREAD = 'thread-game-123';
    const NORMAL_THREAD = 'thread-normal';

    // 1. Mount on game thread
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: GAME_THREAD }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockReconnectGame).toHaveBeenCalledWith(GAME_THREAD);
    mockReconnectGame.mockClear();

    // 2. Switch to normal thread
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: NORMAL_THREAD }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockReconnectGame).toHaveBeenCalledWith(NORMAL_THREAD);
    mockReconnectGame.mockClear();

    // 3. Switch back to game thread
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: GAME_THREAD }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockReconnectGame).toHaveBeenCalledWith(GAME_THREAD);
  });
});
