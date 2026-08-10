import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';
import type { ChatMessage as ChatMessageData, QueueEntry } from '@/stores/chat-types';
import { useSidebarStore } from '@/stores/sidebarStore';

let mockMessages: ChatMessageData[] = [];
let mockQueue: QueueEntry[] = [];
let mockRightPanelMode: 'status' | 'workspace' | 'transcript' = 'status';
let mockWorkspaceMode = 'dev';
const mockCloseRightPanel = vi.fn();
const mockSetRightPanelMode = vi.fn();

const mockStoreState = () => ({
  currentThreadId: 'test-thread',
  threadStates: {},
  messages: mockMessages,
  queue: mockQueue,
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
  threads: [],
  rightPanelMode: mockRightPanelMode,
  workspaceMode: mockWorkspaceMode,
  workspaceSurface: 'home' as const,
  presentationLock: null,
  setRightPanelMode: mockSetRightPanelMode,
  setWorkspaceMode: vi.fn(),
  setWorkspaceSurface: vi.fn(),
  closeRightPanel: mockCloseRightPanel,
});

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: ReturnType<typeof mockStoreState>) => unknown) => {
    const state = mockStoreState();
    return selector ? selector(state) : state;
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
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn() }),
}));
vi.mock('@/hooks/useAuthorization', () => ({
  useAuthorization: () => ({ pending: [], respond: vi.fn(), handleAuthRequest: vi.fn(), handleAuthResponse: vi.fn() }),
}));
vi.mock('@/hooks/useSplitPaneKeys', () => ({ useSplitPaneKeys: vi.fn() }));
vi.mock('@/hooks/useChatSocketCallbacks', () => ({
  useChatSocketCallbacks: () => ({}),
}));

vi.mock('../ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { id: string } }) =>
    React.createElement('div', { 'data-testid': `chat-message-${message.id}` }),
}));
vi.mock('../ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../ChatContainerHeader', () => ({
  ChatContainerHeader: (props: { onToggleSidebar: () => void; onToggleStatusPanel: () => void }) =>
    React.createElement(
      'div',
      { 'data-testid': 'header' },
      React.createElement('button', {
        type: 'button',
        'data-testid': 'sidebar-toggle',
        onClick: props.onToggleSidebar,
      }),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'workspace-toggle',
        onClick: props.onToggleStatusPanel,
      }),
    ),
}));
vi.mock('../ThreadSidebar', () => ({
  ThreadSidebar: (props: { onClose: () => void }) =>
    React.createElement('div', { 'data-testid': 'sidebar', onClick: props.onClose }, 'Sidebar'),
}));
vi.mock('../RightStatusPanel', () => ({
  RightStatusPanel: () => React.createElement('div', { 'data-testid': 'right-status-panel' }),
}));
vi.mock('../WorkspacePanel', () => ({
  WorkspacePanel: (props: { onOpenStatus: () => void }) =>
    React.createElement(
      'div',
      { 'data-testid': 'workspace-panel' },
      React.createElement('button', {
        type: 'button',
        'data-testid': 'workspace-launcher-status',
        onClick: props.onOpenStatus,
      }),
    ),
}));
vi.mock('../workspace/ContextualWorkspaceChrome', () => ({
  ContextualWorkspaceChrome: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'workspace-chrome' }, children),
}));
vi.mock('../workspace/TranscriptPanel', () => ({ TranscriptPanel: () => null }));
vi.mock('../MobileApprovalSheet', () => ({
  MobileApprovalSheet: (props: { open: boolean; onClose: () => void }) =>
    React.createElement('button', {
      type: 'button',
      'data-testid': 'mobile-approval',
      'data-open': String(props.open),
      onClick: props.onClose,
    }),
}));
vi.mock('../ParallelStatusBar', () => ({ ParallelStatusBar: () => null }));
vi.mock('../ThinkingIndicator', () => ({ ThinkingIndicator: () => null }));
vi.mock('../MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('../MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../SplitPaneView', () => ({ SplitPaneView: () => null }));
vi.mock('../AuthorizationCard', () => ({ AuthorizationCard: () => null }));

describe('ChatContainer mobile interactions', () => {
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

  function mockMatchMedia(desktopMatch: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: desktopMatch && query.includes('min-width: 768px'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  beforeEach(() => {
    mockMessages = [];
    mockQueue = [];
    mockRightPanelMode = 'status';
    mockWorkspaceMode = 'dev';
    mockCloseRightPanel.mockReset();
    mockSetRightPanelMode.mockReset();
    useSidebarStore.setState({ isOpen: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockMatchMedia(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  it('sidebar is closed by default on mobile', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
  });

  it('keeps an untouched durable queued user message visible in the timeline', () => {
    mockMessages = [{ id: 'queued-user', type: 'user', content: 'follow-up', timestamp: 1000 }];
    mockQueue = [
      {
        id: 'entry-queued-user',
        threadId: 'test-thread',
        userId: 'user-1',
        content: 'follow-up',
        messageId: 'queued-user',
        mergedMessageIds: [],
        source: 'user',
        targetCats: ['opus'],
        intent: 'execute',
        status: 'queued',
        targetStates: { opus: 'queued' },
        createdAt: 1000,
      },
    ];

    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });

    expect(container.querySelector('[data-testid="chat-message-queued-user"]')).toBeTruthy();
  });

  it('opens sidebar overlay when toggle button is clicked', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    const toggleBtn = container.querySelector('[data-testid="sidebar-toggle"]') as HTMLButtonElement;
    act(() => {
      toggleBtn.click();
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeTruthy();
    expect(container.querySelector('[class*="console-overlay-backdrop"]')).toBeTruthy();
  });

  it('closes sidebar when backdrop is clicked', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    const toggleBtn = container.querySelector('[data-testid="sidebar-toggle"]') as HTMLButtonElement;
    act(() => {
      toggleBtn.click();
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeTruthy();
    const backdrop = container.querySelector('[class*="console-overlay-backdrop"]') as HTMLElement;
    act(() => {
      backdrop.click();
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
  });

  it('opens the full status/session surface from the Workspace Launcher', () => {
    mockRightPanelMode = 'workspace';
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    const triggerBtn = container.querySelector('[data-testid="workspace-launcher-status"]') as HTMLButtonElement;
    expect(triggerBtn).toBeTruthy();
    act(() => {
      triggerBtn.click();
    });
    expect(mockSetRightPanelMode).toHaveBeenCalledWith('status');
  });

  it('renders the approval workspace as a closable mobile sheet', () => {
    mockRightPanelMode = 'workspace';
    mockWorkspaceMode = 'approval';
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });

    const approvalSheet = container.querySelector('[data-testid="mobile-approval"]') as HTMLButtonElement;
    expect(approvalSheet).toBeTruthy();
    expect(approvalSheet.getAttribute('data-open')).toBe('true');

    act(() => approvalSheet.click());
    expect(mockCloseRightPanel).toHaveBeenCalledOnce();
  });

  it('renders the Workspace shell below the desktop breakpoint', async () => {
    mockRightPanelMode = 'workspace';
    mockWorkspaceMode = 'dev';
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });

    expect(container.querySelector('[data-testid="workspace-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workspace-host-pane"]')?.className).toContain('min-w-0');
  });

  it('closes the mobile Workspace overlay with Escape', async () => {
    mockRightPanelMode = 'workspace';
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(mockCloseRightPanel).toHaveBeenCalledOnce();
  });

  it('keeps Workspace mounted across fold and sibling-host switches', async () => {
    mockMatchMedia(true);
    mockRightPanelMode = 'workspace';
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBeTruthy();
    const toggle = container.querySelector('[data-testid="workspace-toggle"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBeTruthy();
    mockRightPanelMode = 'status';
    await act(async () => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });

    expect(container.querySelector('[data-testid="workspace-panel"]')).toBeTruthy();
  });

  it('auto-opens sidebar store on desktop but does not render mobile overlay', () => {
    mockMatchMedia(true);
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    expect(useSidebarStore.getState().isOpen).toBe(true);
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
  });
});
