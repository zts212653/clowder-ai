import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';
import type { ChatMessage, ThreadState } from '@/stores/chat-types';

const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetIntentMode = vi.fn();
const mockSetTargetCats = vi.fn();
const mockSetCurrentThread = vi.fn();
const mockClearUnread = vi.fn();
const mockHandleAgentMessage = vi.fn();
const mockThinkingIndicator = vi.fn((props?: unknown) => {
  void props;
  return null;
});

let capturedSocketCallbacks: {
  onIntentMode?: (data: { threadId: string; mode: string; targetCats: string[] }) => void;
  onMessage?: (msg: unknown) => void;
} | null = null;

function createMockStoreState() {
  return {
    messages: [] as ChatMessage[],
    isLoading: false,
    hasActiveInvocation: false,
    intentMode: null as ThreadState['intentMode'],
    targetCats: [] as string[],
    catStatuses: {} as Record<string, string>,
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
  };
}

let storeState = createMockStoreState();

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: ReturnType<typeof createMockStoreState>) => unknown) => {
    return selector ? selector(storeState) : storeState;
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
vi.mock('../PendingMemberBubble', () => ({
  PendingMemberBubble: ({
    invocationId,
    showCapabilityTip,
    appServerLifecycle,
  }: {
    invocationId: string;
    showCapabilityTip?: boolean;
    appServerLifecycle?: { stage?: string };
  }) =>
    React.createElement('div', {
      'data-testid': 'pending-member-bubble',
      'data-invocation-id': invocationId,
      'data-show-capability-tip': showCapabilityTip ? 'true' : 'false',
      'data-app-server-stage': appServerLifecycle?.stage,
    }),
}));
vi.mock('../ProjectSetupCard', () => ({ ProjectSetupCard: () => null }));
vi.mock('../QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('../RightStatusPanel', () => ({ RightStatusPanel: () => null }));
vi.mock('../ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
vi.mock('../SplitPaneView', () => ({
  SplitPaneView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
vi.mock('../ThinkingIndicator', () => ({
  ThinkingIndicator: (props: unknown) => mockThinkingIndicator(props),
}));
vi.mock('../ThreadExecutionBar', () => ({
  ThreadExecutionBar: () => React.createElement('div', { 'data-testid': 'thread-execution-bar' }),
}));
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
    storeState = createMockStoreState();
    capturedSocketCallbacks = null;
    mockSetLoading.mockClear();
    mockSetHasActiveInvocation.mockClear();
    mockSetIntentMode.mockClear();
    mockSetTargetCats.mockClear();
    mockSetCurrentThread.mockClear();
    mockClearUnread.mockClear();
    mockHandleAgentMessage.mockClear();
    mockThinkingIndicator.mockClear();
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

  it('renders ThinkingIndicator when a single active slot exists even if intentMode is missing', () => {
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      'inv-1': { catId: 'opencode', mode: 'execute', startedAt: Date.now() },
    };
    storeState.intentMode = null;
    storeState.targetCats = [];

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(mockThinkingIndicator).toHaveBeenCalledTimes(1);
  });

  it('renders ThinkingIndicator during single-cat spawn_started before intent_mode registers a slot', () => {
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {};
    storeState.intentMode = null;
    storeState.targetCats = ['codex'];
    storeState.catStatuses = { codex: 'spawning' };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(mockThinkingIndicator).toHaveBeenCalledTimes(1);
  });

  it('renders one pending member bubble before an active invocation has produced assistant output', () => {
    storeState.messages = [
      {
        id: 'user-start-invocation',
        type: 'user',
        content: '@codex 开始',
        timestamp: Date.now() - 2_000,
        extra: { targetCats: ['codex'] },
      },
    ];
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      'inv-codex-55': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 1_000 },
    };
    storeState.intentMode = 'execute';
    storeState.targetCats = ['codex'];
    storeState.catStatuses = { codex: 'spawning' };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    const pending = container.querySelector('[data-testid="pending-member-bubble"]');
    expect(pending?.getAttribute('data-invocation-id')).toBe('inv-codex-55');
  });

  it('does not let lifecycle activity create a gap before a formal bubble exists', () => {
    storeState.messages = [
      {
        id: 'user-start-invocation',
        type: 'user',
        content: '@codex 开始',
        timestamp: Date.now() - 2_000,
        extra: { targetCats: ['codex'] },
      },
    ];
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      'inv-codex-55': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 1_000 },
    };
    storeState.intentMode = 'execute';
    storeState.targetCats = ['codex'];
    storeState.catStatuses = { codex: 'streaming' };
    storeState.catInvocations = {
      codex: {
        invocationId: 'inv-codex-55',
        appServerLifecycle: {
          stage: 'active',
          lastActivityAt: Date.now(),
          recoveryAttempt: 0,
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: true,
        },
      },
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="pending-member-bubble"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thread-execution-bar"]')).not.toBeNull();
  });

  it('keeps the placeholder after app-server accepts the turn until a formal bubble can take over', () => {
    storeState.messages = [
      {
        id: 'user-start-accepted-turn',
        type: 'user',
        content: '@codex 开始',
        timestamp: Date.now() - 2_000,
        extra: { targetCats: ['codex'] },
      },
    ];
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      'inv-codex-accepted': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 1_000 },
    };
    storeState.intentMode = 'execute';
    storeState.targetCats = ['codex'];
    storeState.catStatuses = { codex: 'streaming' };
    storeState.catInvocations = {
      codex: {
        invocationId: 'inv-codex-accepted',
        appServerLifecycle: {
          stage: 'turn_accepted',
          lastActivityAt: Date.now(),
          recoveryAttempt: 0,
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: false,
        },
      },
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="pending-member-bubble"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thread-execution-bar"]')).not.toBeNull();

    storeState.messages = [
      ...storeState.messages,
      {
        id: 'msg-inv-codex-accepted-codex',
        type: 'assistant',
        catId: 'codex',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-codex-accepted' } },
      },
    ];

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="pending-member-bubble"]')).toBeNull();
  });

  it('does not render a second Kimi avatar when an ACP draft carries the real parent + child identity', () => {
    const parentInvocationId = 'eefcfc03-e188-4f8c-ac6d-435e76fc8b6f';
    const turnInvocationId = 'd2abf34d-47fb-42a6-80e2-fae40e1d18cf';
    storeState.messages = [
      {
        id: `draft-${turnInvocationId}`,
        type: 'assistant',
        catId: 'kimi',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
        thinking: 'Check the current git state.',
        toolEvents: [{ id: 'tool-1', type: 'tool_use', label: 'kimi → Bash', timestamp: Date.now() }],
        extra: {
          stream: { invocationId: parentInvocationId, turnInvocationId },
          turnExecution: {
            invocationId: turnInvocationId,
            parentInvocationId,
            executionKind: 'ordinary',
          },
        },
      },
    ];
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      [parentInvocationId]: { catId: 'kimi', mode: 'execute', startedAt: Date.now() - 1_000 },
    };
    storeState.intentMode = 'execute';
    storeState.targetCats = ['kimi'];
    storeState.catStatuses = { kimi: 'streaming' };
    storeState.catInvocations = {
      kimi: { invocationId: parentInvocationId, turnInvocationId },
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="pending-member-bubble"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-execution-bar"]')).not.toBeNull();
  });

  it('keeps the placeholder for a new invocation when the cat status is stale from a previous turn', () => {
    storeState.messages = [
      {
        id: 'user-start-invocation',
        type: 'user',
        content: '@codex 再来一轮',
        timestamp: Date.now() - 2_000,
        extra: { targetCats: ['codex'] },
      },
    ];
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      'inv-codex-99': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 1_000 },
    };
    storeState.intentMode = 'execute';
    storeState.targetCats = ['codex'];
    // Stale per-cat state from the previous turn: status stuck at streaming and
    // the lifecycle snapshot still describes the old invocation.
    storeState.catStatuses = { codex: 'streaming' };
    storeState.catInvocations = {
      codex: {
        invocationId: 'inv-codex-55',
        appServerLifecycle: {
          stage: 'active',
          lastActivityAt: Date.now() - 60_000,
          recoveryAttempt: 0,
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: true,
        },
      },
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    const pending = container.querySelector('[data-testid="pending-member-bubble"]');
    expect(pending?.getAttribute('data-invocation-id')).toBe('inv-codex-99');
  });

  it('does not add a second avatar when a later msg-box message arrives during the same visible invocation', () => {
    storeState.messages = [
      {
        id: 'msg-inv-codex-55-codex',
        type: 'assistant',
        catId: 'codex',
        content: '正在输出已有回合',
        timestamp: Date.now() - 2_000,
        isStreaming: true,
        extra: { stream: { invocationId: 'inv-codex-55' } },
      },
      {
        id: 'user-to-sol',
        type: 'user',
        content: '@codex-sol 请只让 5.6 看',
        timestamp: Date.now(),
        extra: { targetCats: ['codex-sol'] },
      },
    ];
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      'inv-codex-55': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 360_000 },
    };
    storeState.intentMode = 'execute';
    storeState.targetCats = ['codex'];

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="pending-member-bubble"]')).toBeNull();
  });

  it('does not add a placeholder avatar for an auxiliary execution attached to visible output', () => {
    storeState.messages = [
      {
        id: 'msg-parent-1-gpt52',
        type: 'assistant',
        catId: 'gpt52',
        content: '普通回合已经有可见输出',
        timestamp: Date.now() - 1_000,
        isStreaming: true,
        extra: {
          stream: { invocationId: 'parent-1', turnInvocationId: 'ordinary-turn-1' },
          auxiliaryTurnExecutions: [
            {
              invocationId: 'routing-guard-turn-1',
              parentInvocationId: 'parent-1',
              executionKind: 'routing_guard',
            },
          ],
        },
      },
    ];
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      'routing-guard-turn-1': { catId: 'gpt52', mode: 'execute', startedAt: Date.now() - 500 },
    };

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="pending-member-bubble"]')).toBeNull();
  });

  it('still renders a pending avatar for a newer invocation when the same cat only has older output', () => {
    storeState.messages = [
      {
        id: 'msg-inv-old-codex',
        type: 'assistant',
        catId: 'codex',
        content: '上一轮输出',
        timestamp: Date.now() - 10_000,
        extra: { stream: { invocationId: 'inv-old' } },
      },
    ];
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      'inv-new': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 1_000 },
    };
    storeState.intentMode = 'execute';
    storeState.targetCats = ['codex'];

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    const pending = container.querySelector('[data-testid="pending-member-bubble"]');
    expect(pending?.getAttribute('data-invocation-id')).toBe('inv-new');
  });

  it('keeps one placeholder per executing cat until each has a formal bubble', () => {
    storeState.messages = [
      {
        id: 'user-start-parallel',
        type: 'user',
        content: '@codex @opus 开始',
        timestamp: Date.now() - 180_000,
        extra: { targetCats: ['codex', 'opus'] },
      },
    ];
    storeState.hasActiveInvocation = true;
    storeState.activeInvocations = {
      'inv-stalled': { catId: 'codex', mode: 'execute', startedAt: Date.now() - 180_000 },
      'inv-healthy': { catId: 'opus', mode: 'execute', startedAt: Date.now() - 1_000 },
    };
    storeState.catStatuses = { codex: 'streaming', opus: 'streaming' };
    storeState.catInvocations = {
      codex: {
        invocationId: 'inv-stalled',
        appServerLifecycle: {
          stage: 'active',
          lastActivityAt: Date.now() - 120_001,
          recoveryAttempt: 0,
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: false,
        },
      },
      opus: {
        invocationId: 'inv-healthy',
        appServerLifecycle: {
          stage: 'active',
          lastActivityAt: Date.now(),
          recoveryAttempt: 0,
          turnStartSent: true,
          turnAccepted: true,
          itemObserved: true,
        },
      },
    };
    storeState.intentMode = 'execute';
    storeState.targetCats = ['codex', 'opus'];

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(container.querySelectorAll('[data-testid="pending-member-bubble"]')).toHaveLength(2);
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
