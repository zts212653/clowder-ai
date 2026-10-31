import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';
import { useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { ThreadChatRuntimeProvider } from '@/components/thread-chat';
import { createArtifactReviewSurface } from '@/components/workbench/artifact-review-surface';
import {
  createArtifactWorkPresentationState,
  reduceArtifactWorkPresentation,
} from '@/components/workbench/artifact-work-presentation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import {
  createBrowserSurface,
  createEvolutionProgramSurface,
  createWorkspaceModeSurface,
} from '@/components/workbench/real-surface-adapters';
import { useWorkspaceChatReveal } from '@/components/workbench/WorkspaceChatReveal';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import type { ChatMessage as ChatMessageData, QueueEntry } from '@/stores/chat-types';
import { useSidebarStore } from '@/stores/sidebarStore';
import { CHAT_LAYOUT_CHANGED_EVENT, isChatReadingCaptureRequest } from '@/utils/chat-layout-change';

function renderChatContainer(threadId: string) {
  return React.createElement(
    ThreadChatRuntimeProvider,
    { routeThreadId: threadId },
    React.createElement(ChatContainer, { threadId }),
  );
}

let mockMessages: ChatMessageData[] = [];
let mockQueue: QueueEntry[] = [];
let mockRightPanelMode: 'status' | 'workspace' | 'transcript' = 'status';
let mockRightPanelOpen = false;
let mockWorkspaceMode = 'dev';
let mockViewMode: 'single' | 'split' = 'single';
let mockCurrentThreadId = 'test-thread';
let mockConnectionStatus = {
  api: 'online' as const,
  socket: 'online' as const,
  upstream: 'online' as const,
  browserOnline: true,
  isReadonly: false,
  forwardingBlocked: false,
  updateRequired: false,
  checkedAt: 1,
};
let mockForwardSubmissions = 0;
const mockCloseRightPanel = vi.fn();
const mockSetRightPanelMode = vi.fn();
const mockSetRightPanelOpen = vi.fn();
const PROGRAM_SURFACE = createEvolutionProgramSurface(`evolution-program:${'c'.repeat(32)}`);
const REVIEW_SURFACE = createArtifactReviewSurface(`review-${'d'.repeat(64)}`, 'thread-source');

const mockStoreState = () => ({
  currentThreadId: mockCurrentThreadId,
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

  viewMode: mockViewMode,
  setViewMode: vi.fn(),
  clearUnread: vi.fn(),
  confirmUnreadAck: vi.fn(),
  settleUnreadAck: vi.fn(),
  armUnreadSuppression: vi.fn(),
  splitPaneThreadIds: [],
  setSplitPaneThreadIds: vi.fn(),
  setSplitPaneTarget: vi.fn(),
  threads: [],
  rightPanelMode: mockRightPanelMode,
  rightPanelOpen: mockRightPanelOpen,
  setRightPanelOpen: mockSetRightPanelOpen,
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
  return { useChatStore: Object.assign(hook, { getState: () => mockStoreState() }) };
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
  }),
}));
vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    messages: mockStoreState().messages,
    handleReadingIntent: vi.fn(),
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
vi.mock('@/hooks/useSplitPaneKeys', () => ({ useSplitPaneKeys: vi.fn() }));
vi.mock('@/hooks/useChatSocketCallbacks', () => ({
  useChatSocketCallbacks: () => ({}),
}));
vi.mock('@/hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => mockConnectionStatus,
}));

vi.mock('../ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { id: string } }) =>
    React.createElement('div', { 'data-testid': `chat-message-${message.id}` }),
}));
vi.mock('../ChatInput', () => ({
  ChatInput: (props: { disabled?: boolean }) =>
    React.createElement('button', {
      type: 'button',
      'data-testid': 'chat-input',
      'data-disabled': props.disabled ? 'true' : 'false',
    }),
}));
vi.mock('../ChatContainerHeader', () => ({
  ChatContainerHeader: (props: {
    onToggleSidebar: () => void;
    onToggleStatusPanel: () => void;
    onOpenMessageSearch?: () => void;
  }) => {
    const lightbox = useArtworkLightboxScope();
    return React.createElement(
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
      props.onOpenMessageSearch &&
        React.createElement('button', { type: 'button', onClick: props.onOpenMessageSearch }, '查找消息'),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'open-artwork-lightbox',
        onClick: () =>
          lightbox?.open({
            url: '/uploads/original.png',
            title: '原作品',
            alt: '原作品',
            mediaType: 'image',
            surface: null,
          }),
      }),
    );
  },
}));
vi.mock('../ThreadSidebar', () => ({
  ThreadSidebar: (props: { onClose: () => void }) =>
    React.createElement('div', { 'data-testid': 'sidebar', onClick: props.onClose }, 'Sidebar'),
}));
vi.mock('../RightStatusPanel', () => ({
  RightStatusPanel: () => React.createElement('div', { 'data-testid': 'right-status-panel' }),
}));
vi.mock('../workspace-status/StatusPresentation', () => ({
  StatusPresentation: () => React.createElement('div', { 'data-testid': 'right-status-panel' }),
}));
vi.mock('../WorkspacePanel', () => ({
  WorkspacePanel: (props: { statusSurface?: React.ReactNode; visible?: boolean }) => {
    const [statusOpen, setStatusOpen] = React.useState(false);
    const [programFace, setProgramFace] = React.useState<'judgment' | 'history'>('judgment');
    const requestChat = useWorkspaceChatReveal();
    return React.createElement(
      'div',
      { 'data-testid': 'workspace-panel', 'data-workspace-visible': String(props.visible) },
      ...['test-thread', 'another-thread'].map((threadId) =>
        React.createElement('button', {
          key: threadId,
          type: 'button',
          'data-testid': `request-chat-${threadId}`,
          onClick: () => requestChat?.(threadId),
        }),
      ),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'workspace-launcher-status',
        onClick: () => setStatusOpen(true),
      }),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'mock-program-history',
          onClick: () => setProgramFace('history'),
        },
        '更改历史',
      ),
      React.createElement(
        'div',
        {
          'data-testid': 'mock-program-scroll',
          'data-program-face': programFace,
          style: { height: '40px', overflowY: 'auto' },
        },
        React.createElement('div', { style: { height: '400px' } }, programFace),
      ),
      statusOpen ? props.statusSurface : null,
    );
  },
}));
vi.mock('../workspace/ContextualWorkspaceChrome', () => ({
  ContextualWorkspaceChrome: ({
    children,
    onFold,
    showFold,
  }: {
    children: React.ReactNode;
    onFold: () => void;
    showFold?: boolean;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'workspace-chrome' },
      showFold
        ? React.createElement('button', {
            type: 'button',
            'data-testid': 'workspace-shell-fold',
            onClick: onFold,
          })
        : null,
      children,
    ),
}));
vi.mock('../workspace/TranscriptPanel', () => ({ TranscriptPanel: () => null }));
vi.mock('../MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('../MessageActions', () => ({
  MessageActions: ({
    children,
    message,
    onEnterSelection,
    forwardingDisabled,
  }: {
    children: React.ReactNode;
    message?: { id: string };
    onEnterSelection?: (messageId: string) => void;
    forwardingDisabled?: boolean;
  }) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement('output', {
        'data-testid': message ? `forwarding-admission-${message.id}` : undefined,
        'data-disabled': String(Boolean(forwardingDisabled)),
      }),
      children,
      message && onEnterSelection
        ? React.createElement('button', {
            type: 'button',
            'data-testid': `enter-selection-${message.id}`,
            onClick: () => onEnterSelection(message.id),
          })
        : null,
    ),
}));
vi.mock('../MessageSelectionToolbar', () => ({
  MessageSelectionToolbar: ({
    onForward,
    forwardingDisabled,
  }: {
    onForward: () => void;
    forwardingDisabled: boolean;
  }) =>
    React.createElement('button', {
      type: 'button',
      'data-testid': 'selection-forward',
      'data-disabled': String(forwardingDisabled),
      disabled: forwardingDisabled,
      onClick: onForward,
    }),
}));
vi.mock('../TransferTargetPicker', () => ({
  TransferTargetPicker: ({ open }: { open: boolean }) =>
    open
      ? React.createElement('button', {
          type: 'button',
          'data-testid': 'transfer-submit',
          onClick: () => {
            mockForwardSubmissions += 1;
          },
        })
      : null,
}));
vi.mock('../SplitPaneView', () => ({
  SplitPaneView: () => null,
  SplitPaneChatView: () => null,
}));

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

  function requestChat(threadId = 'test-thread') {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="request-chat-${threadId}"]`);
    if (!button) throw new Error('expected a Workspace leaf requesting its original Chat');
    button.click();
  }

  beforeEach(() => {
    mockMessages = [];
    mockQueue = [];
    mockRightPanelMode = 'status';
    mockRightPanelOpen = false;
    mockWorkspaceMode = 'dev';
    mockViewMode = 'single';
    mockCurrentThreadId = 'test-thread';
    mockConnectionStatus = {
      api: 'online',
      socket: 'online',
      upstream: 'online',
      browserOnline: true,
      isReadonly: false,
      forwardingBlocked: false,
      updateRequired: false,
      checkedAt: 1,
    };
    mockForwardSubmissions = 0;
    mockCloseRightPanel.mockReset();
    mockSetRightPanelMode.mockReset();
    mockSetRightPanelOpen.mockReset();
    useSidebarStore.setState({ isOpen: false });
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
      mainAreaAttentionPresentation: { kind: 'overlay' },
      focusSurfaceId: null,
      artifactWorkPresentation: createArtifactWorkPresentationState(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockMatchMedia(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    writeShellPresentation('classic');
    localStorage.removeItem('cat-cafe:chatBasis');
    container.remove();
    vi.restoreAllMocks();
  });
  it('sidebar is closed by default on mobile', () => {
    act(() => {
      root.render(renderChatContainer('test-thread'));
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
  });

  it.each([
    { desktop: false, cover: 'workspace' },
    { desktop: true, cover: 'workspace' },
    { desktop: false, cover: 'artwork' },
    { desktop: true, cover: 'artwork' },
  ])('keeps the search trip while $cover covers Chat (desktop=$desktop)', ({ desktop, cover }) => {
    writeShellPresentation('v2');
    mockMatchMedia(desktop);
    const id = 'a7eafdfa-513c-4129-8acd-9f4cc8df1aa1';
    const key = `cat-cafe:message-reading-session:${id}`;
    const saved = JSON.stringify({
      v: 1,
      session: {
        id,
        originPersisted: true,
        trip: {
          searchId: 'original-search',
          origin: { threadId: 'test-thread', readingRef: 'original-reading-ref' },
          targets: [{ threadId: 'test-thread', messageId: 'exact-message' }],
          generation: 1,
          settledIndex: 0,
          pending: null,
          status: 'ready',
        },
      },
    });
    localStorage.setItem('cat-cafe:message-reading-active:v1', id);
    localStorage.setItem(key, saved);
    const controls = () => document.querySelector('nav[aria-label="浏览本次检索结果"]');
    try {
      act(() => root.render(renderChatContainer('test-thread')));
      const chat = container.querySelector('[data-testid="thread-chat-host"]');
      const input = container.querySelector('[data-testid="chat-input"]');
      expect(controls()).not.toBeNull();
      expect(chat?.contains(controls())).toBe(true);
      if (cover === 'artwork') {
        act(() => container.querySelector<HTMLButtonElement>('[data-testid="open-artwork-lightbox"]')?.click());
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      } else {
        mockRightPanelMode = 'workspace';
        mockRightPanelOpen = true;
        act(() => root.render(renderChatContainer('test-thread')));
      }
      expect(controls() !== null).toBe(cover === 'workspace' && desktop);
      expect(localStorage.getItem(key)).toBe(saved);
      if (cover === 'artwork') {
        act(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭作品"]')?.click());
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      } else {
        mockRightPanelOpen = false;
        act(() => root.render(renderChatContainer('test-thread')));
      }
      expect(controls()).not.toBeNull();
      expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
      expect(localStorage.getItem(key)).toBe(saved);
    } finally {
      localStorage.removeItem(key);
      localStorage.removeItem('cat-cafe:message-reading-active:v1');
    }
  });

  it('keeps quote forwarding locked for a stale document and enables it after a refreshed compatible baseline', () => {
    mockMessages = [
      {
        id: 'quote-source',
        type: 'assistant',
        catId: 'codex-sol',
        content: 'exact selected fragment',
        timestamp: 1,
      },
    ];
    mockConnectionStatus = {
      ...mockConnectionStatus,
      isReadonly: true,
      forwardingBlocked: true,
      updateRequired: true,
    };

    act(() => {
      root.render(renderChatContainer('test-thread'));
    });
    act(() => {
      (container.querySelector('[data-testid="enter-selection-quote-source"]') as HTMLButtonElement).click();
    });
    act(() => {
      (container.querySelector('[data-testid="selection-forward"]') as HTMLButtonElement).click();
    });

    expect(container.querySelector('[data-testid="runtime-update-required"]')).toBeTruthy();
    expect(
      container.querySelector('[data-testid="forwarding-admission-quote-source"]')?.getAttribute('data-disabled'),
    ).toBe('true');
    expect(container.querySelector('[data-testid="transfer-submit"]')).toBeNull();
    expect(mockForwardSubmissions).toBe(0);

    act(() => root.unmount());
    root = createRoot(container);
    mockConnectionStatus = {
      ...mockConnectionStatus,
      isReadonly: false,
      forwardingBlocked: false,
      updateRequired: false,
    };
    act(() => {
      root.render(renderChatContainer('test-thread'));
    });
    expect(
      container.querySelector('[data-testid="forwarding-admission-quote-source"]')?.getAttribute('data-disabled'),
    ).toBe('false');
    act(() => {
      (container.querySelector('[data-testid="enter-selection-quote-source"]') as HTMLButtonElement).click();
    });
    act(() => {
      (container.querySelector('[data-testid="selection-forward"]') as HTMLButtonElement).click();
    });
    act(() => {
      (container.querySelector('[data-testid="transfer-submit"]') as HTMLButtonElement).click();
    });

    expect(mockForwardSubmissions).toBe(1);
  });

  it('keeps the multi-select forward action disabled before verification and after mismatch', () => {
    mockMessages = [
      {
        id: 'multi-select-source',
        type: 'assistant',
        catId: 'codex-sol',
        content: 'selected message',
        timestamp: 1,
      },
    ];
    mockConnectionStatus = {
      ...mockConnectionStatus,
      isReadonly: false,
      forwardingBlocked: true,
      updateRequired: false,
    };

    act(() => {
      root.render(renderChatContainer('test-thread'));
    });
    // The 2026-08-17 outage in one assertion: an unverified deployment closes
    // forwarding, but must never take plain sending down with it.
    expect(container.querySelector('[data-testid="chat-input"]')?.getAttribute('data-disabled')).toBe('false');
    act(() => {
      (container.querySelector('[data-testid="enter-selection-multi-select-source"]') as HTMLButtonElement).click();
    });

    const initialForward = container.querySelector('[data-testid="selection-forward"]') as HTMLButtonElement;
    expect(initialForward.disabled).toBe(true);
    expect(initialForward.getAttribute('data-disabled')).toBe('true');
    expect(container.querySelector('[data-testid="runtime-update-required"]')).toBeNull();
    act(() => initialForward.click());
    expect(container.querySelector('[data-testid="transfer-submit"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    mockConnectionStatus = {
      ...mockConnectionStatus,
      isReadonly: true,
      forwardingBlocked: true,
      updateRequired: true,
    };
    act(() => {
      root.render(renderChatContainer('test-thread'));
    });
    // A detected mismatch is the one state that does close the composer too.
    expect(container.querySelector('[data-testid="chat-input"]')?.getAttribute('data-disabled')).toBe('true');
    act(() => {
      (container.querySelector('[data-testid="enter-selection-multi-select-source"]') as HTMLButtonElement).click();
    });

    const staleForward = container.querySelector('[data-testid="selection-forward"]') as HTMLButtonElement;
    expect(staleForward.disabled).toBe(true);
    expect(container.querySelector('[data-testid="runtime-update-required"]')).toBeTruthy();
    act(() => staleForward.click());
    expect(container.querySelector('[data-testid="transfer-submit"]')).toBeNull();
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
        from: { kind: 'user', userId: 'test-user' },
        targetCats: ['opus'],
        intent: 'execute',
        status: 'queued',
        createdAt: 1000,
      },
    ];

    act(() => {
      root.render(renderChatContainer('test-thread'));
    });

    expect(container.querySelector('[data-testid="chat-message-queued-user"]')).toBeTruthy();
  });

  it('opens sidebar overlay when toggle button is clicked', () => {
    act(() => {
      root.render(renderChatContainer('test-thread'));
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
      root.render(renderChatContainer('test-thread'));
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

  it('keeps the status/session owner inside the Workspace instead of replacing the host', () => {
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    act(() => {
      root.render(renderChatContainer('test-thread'));
    });
    const triggerBtn = container.querySelector('[data-testid="workspace-launcher-status"]') as HTMLButtonElement;
    expect(triggerBtn).toBeTruthy();
    act(() => {
      triggerBtn.click();
    });
    expect(container.querySelector('[data-testid="right-status-panel"]')).toBeTruthy();
    expect(mockSetRightPanelMode).not.toHaveBeenCalledWith('status');
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBeTruthy();
  });

  it('keeps the canonical F307 surface visible when legacy approval mode survives on mobile', () => {
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    mockWorkspaceMode = 'approval';
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([REVIEW_SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
    });
    act(() => {
      root.render(renderChatContainer('test-thread'));
    });

    const host = container.querySelector<HTMLElement>('[data-testid="contextual-workspace-host"]');
    const workspace = container.querySelector<HTMLElement>('[data-testid="workspace-panel"]');
    expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(REVIEW_SURFACE.id);
    expect(host?.classList.contains('hidden')).toBe(false);
    expect(workspace?.dataset.workspaceVisible).toBe('true');
    expect(container.querySelector('[data-testid="mobile-approval-sheet"]')).toBeNull();
  });

  it('renders the Workspace shell below the desktop breakpoint', async () => {
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    mockWorkspaceMode = 'dev';
    await act(async () => {
      root.render(renderChatContainer('test-thread'));
    });

    expect(container.querySelector('[data-testid="workspace-panel"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="workspace-host-pane"]')?.className).toContain('min-w-0');
  });

  it('closes the mobile Workspace overlay with Escape', async () => {
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    await act(async () => {
      root.render(renderChatContainer('test-thread'));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(mockCloseRightPanel).toHaveBeenCalledOnce();
  });

  it.each(['composition', 'handled'])('keeps the mobile owner when Escape belongs to %s input', async (kind) => {
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    await act(async () => root.render(renderChatContainer('test-thread')));
    const composer = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
    if (!composer) throw new Error('composer missing');
    if (kind === 'handled') composer.addEventListener('keydown', (event) => event.preventDefault());
    await act(async () =>
      composer.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          isComposing: kind === 'composition',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(mockCloseRightPanel).not.toHaveBeenCalled();
  });

  it.each([false, true])('reveals the original Chat from a covering v2 Workspace on desktop=%s', async (desktop) => {
    writeShellPresentation('v2');
    mockMatchMedia(desktop);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([PROGRAM_SURFACE]) });
    await act(async () => root.render(renderChatContainer('test-thread')));
    if (desktop)
      await act(async () => useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(PROGRAM_SURFACE.id));
    const chat = container.querySelector('[data-testid="thread-chat-host"]');
    const owner = container.querySelector('[data-testid="workspace-panel"]');
    const layout = useF307ExperienceWorkbenchStore.getState().layout;
    const order: string[] = [];
    const capture = (event: Event) => {
      if (isChatReadingCaptureRequest(event)) order.push('capture');
    };
    mockCloseRightPanel.mockImplementation(() => {
      expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
      order.push('close');
      mockRightPanelOpen = false;
      mockRightPanelMode = 'status';
    });
    window.addEventListener(CHAT_LAYOUT_CHANGED_EVENT, capture);
    try {
      await act(async () => requestChat());
      expect(order).toEqual(['capture', 'close']);
      await act(async () => root.render(renderChatContainer('test-thread')));
      expect(container.querySelector('[data-testid="thread-chat-host"]')).toBe(chat);
      expect(container.querySelector('[data-testid="workspace-panel"]')).toBe(owner);
      expect(container.querySelector('[data-testid="contextual-workspace-host"]')?.getAttribute('aria-hidden')).toBe(
        'true',
      );
      expect(useF307ExperienceWorkbenchStore.getState().layout).toBe(layout);
    } finally {
      window.removeEventListener(CHAT_LAYOUT_CHANGED_EVENT, capture);
    }
  });

  it.each([
    { presentation: 'v2' as const, desktop: true, threadId: 'test-thread', open: true, mode: 'workspace' as const },
    { presentation: 'v2' as const, desktop: false, threadId: 'another-thread', open: true, mode: 'workspace' as const },
    {
      presentation: 'classic' as const,
      desktop: false,
      threadId: 'test-thread',
      open: true,
      mode: 'workspace' as const,
    },
    { presentation: 'v2' as const, desktop: false, threadId: 'test-thread', open: false, mode: 'workspace' as const },
    { presentation: 'v2' as const, desktop: false, threadId: 'test-thread', open: true, mode: 'status' as const },
  ])('does not fold an uncovered or foreign Chat: $presentation/$desktop/$threadId/$open/$mode', async ({
    presentation,
    desktop,
    threadId,
    open,
    mode,
  }) => {
    writeShellPresentation(presentation);
    mockMatchMedia(desktop);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    await act(async () => root.render(renderChatContainer('test-thread')));
    mockRightPanelOpen = open;
    mockRightPanelMode = mode;
    await act(async () => root.render(renderChatContainer('test-thread')));
    await act(async () => requestChat(threadId));
    expect(mockCloseRightPanel).not.toHaveBeenCalled();
  });

  it('rejects a reveal from the previous thread before its host has rerendered', async () => {
    writeShellPresentation('v2');
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    await act(async () => root.render(renderChatContainer('test-thread')));
    mockCurrentThreadId = 'another-thread';
    await act(async () => requestChat());
    expect(mockCloseRightPanel).not.toHaveBeenCalled();
  });

  it('keeps full-window Artifact work when its original composer is already available', async () => {
    writeShellPresentation('v2');
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    const opened = reduceArtifactWorkPresentation(createArtifactWorkPresentationState(), {
      type: 'begin',
      initiator: 'user',
      threadId: 'test-thread',
      surfaceId: REVIEW_SURFACE.id,
      returnHandle: {
        host: { owner: 'chat-container', key: 'test-thread' },
        workbench: { owner: 'f307', key: REVIEW_SURFACE.id },
        chatReadingRef: null,
        client: REVIEW_SURFACE.ownerStateRef,
      },
    }).state;
    const session = opened.session;
    if (!session) throw new Error('expected the original Artifact work presentation');
    const fullWindow = reduceArtifactWorkPresentation(opened, {
      type: 'enter-full-window',
      initiator: 'user',
      generation: session.generation,
      threadId: session.threadId,
      surfaceId: session.surfaceId,
    }).state;
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([REVIEW_SURFACE]),
      artifactWorkPresentation: fullWindow,
    });
    await act(async () => root.render(renderChatContainer('test-thread')));
    expect(
      container.querySelector('[data-testid="contextual-workspace-host"]')?.getAttribute('data-presentation'),
    ).toBe('artifact-full-window');
    await act(async () => requestChat());
    expect(mockCloseRightPanel).not.toHaveBeenCalled();
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation).toBe(fullWindow);
  });

  it.each([
    { presentation: 'classic' as const, desktop: false, foldVisible: true },
    { presentation: 'v2' as const, desktop: false, foldVisible: true },
    { presentation: 'v2' as const, desktop: true, foldVisible: true },
    { presentation: 'classic' as const, desktop: true, foldVisible: false },
  ])('keeps the $presentation host fold action correct on desktop=$desktop', async ({
    presentation,
    desktop,
    foldVisible,
  }) => {
    writeShellPresentation(presentation);
    mockMatchMedia(desktop);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    await act(async () => {
      root.render(renderChatContainer('test-thread'));
    });

    const fold = container.querySelector<HTMLButtonElement>('[data-testid="workspace-shell-fold"]');
    expect(Boolean(fold)).toBe(foldVisible);
    if (foldVisible) {
      if (!fold) throw new Error('the Workspace host fold control is missing');
      const order: string[] = [];
      const onCapture = (event: Event) => {
        if (isChatReadingCaptureRequest(event)) order.push('capture');
      };
      mockCloseRightPanel.mockImplementation(() => order.push('close'));
      window.addEventListener(CHAT_LAYOUT_CHANGED_EVENT, onCapture);
      try {
        await act(async () => fold.click());
        expect(mockCloseRightPanel).toHaveBeenCalledOnce();
        expect(order).toEqual(presentation === 'v2' ? ['capture', 'close'] : ['close']);
      } finally {
        window.removeEventListener(CHAT_LAYOUT_CHANGED_EVENT, onCapture);
      }
    } else {
      expect(mockCloseRightPanel).not.toHaveBeenCalled();
    }
  });

  it.each([
    'v2',
    'classic',
  ] as const)('captures the %s reading owner before opening Workspace', async (presentation) => {
    writeShellPresentation(presentation);
    mockMatchMedia(true);
    await act(async () => root.render(renderChatContainer('test-thread')));
    const order: string[] = [];
    const onCapture = (event: Event) => {
      if (isChatReadingCaptureRequest(event)) order.push('capture');
    };
    mockSetRightPanelMode.mockImplementation(() => order.push('mode'));
    mockSetRightPanelOpen.mockImplementation(() => order.push('open'));
    window.addEventListener(CHAT_LAYOUT_CHANGED_EVENT, onCapture);
    try {
      const toggle = container.querySelector<HTMLButtonElement>('[data-testid="workspace-toggle"]');
      expect(toggle).not.toBeNull();
      await act(async () => toggle?.click());
      expect(order).toEqual(presentation === 'v2' ? ['capture', 'mode', 'open'] : ['mode', 'open']);
    } finally {
      window.removeEventListener(CHAT_LAYOUT_CHANGED_EVENT, onCapture);
    }
  });

  it('keeps Workspace mounted across fold and sibling-host switches', async () => {
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    await act(async () => {
      root.render(renderChatContainer('test-thread'));
    });
    const workspace = container.querySelector<HTMLElement>('[data-testid="workspace-panel"]');
    expect(workspace).toBeTruthy();
    expect(workspace?.dataset.workspaceVisible).toBe('true');
    const toggle = container.querySelector('[data-testid="workspace-toggle"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBe(workspace);
    mockRightPanelMode = 'status';
    await act(async () => {
      root.render(renderChatContainer('test-thread'));
    });

    expect(container.querySelector('[data-testid="workspace-panel"]')).toBe(workspace);
    expect(workspace?.dataset.workspaceVisible).toBe('false');

    mockRightPanelMode = 'workspace';
    await act(async () => {
      root.render(renderChatContainer('test-thread'));
    });
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBe(workspace);
    expect(workspace?.dataset.workspaceVisible).toBe('true');

    const documentVisibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(workspace?.dataset.workspaceVisible).toBe('false');
    documentVisibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(workspace?.dataset.workspaceVisible).toBe('true');
    documentVisibility.mockRestore();
  });

  it('moves the same Workspace instance over the main area and returns without losing owner state', async () => {
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([PROGRAM_SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
    });
    await act(async () => {
      root.render(renderChatContainer('test-thread'));
    });

    const workspaceBefore = container.querySelector<HTMLElement>('[data-testid="workspace-panel"]');
    const programScrollBefore = container.querySelector<HTMLElement>('[data-testid="mock-program-scroll"]');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mock-program-history"]')?.click();
    });
    if (programScrollBefore) programScrollBefore.scrollTop = 96;

    await act(async () => {
      useF307ExperienceWorkbenchStore.setState({ mainAreaAttentionSurfaceId: PROGRAM_SURFACE.id });
    });

    const host = container.querySelector<HTMLElement>('[data-testid="contextual-workspace-host"]');
    const chat = container.querySelector<HTMLElement>('[data-testid="thread-chat-host"]');
    const workspaceAfter = container.querySelector<HTMLElement>('[data-testid="workspace-panel"]');
    const programScrollAfter = container.querySelector<HTMLElement>('[data-testid="mock-program-scroll"]');
    expect(host?.dataset.presentation).toBe('main-area-attention');
    expect(host?.getAttribute('aria-label')).toBe('主区 Workspace');
    expect(host?.className).toContain('absolute');
    expect(host?.className).toContain('inset-0');
    expect(chat?.getAttribute('aria-hidden')).toBe('true');
    expect(chat?.className).toContain('invisible');
    expect(workspaceAfter).toBe(workspaceBefore);
    expect(programScrollAfter).toBe(programScrollBefore);
    expect(programScrollAfter?.dataset.programFace).toBe('history');
    expect(programScrollAfter?.scrollTop).toBe(96);

    await act(async () => {
      useF307ExperienceWorkbenchStore.getState().exitMainAreaAttention();
    });
    expect(host?.dataset.presentation).toBe('right-rail');
    expect(host?.getAttribute('aria-label')).toBe('上下文侧栏');
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBe(workspaceBefore);
    expect(programScrollAfter?.dataset.programFace).toBe('history');
    expect(programScrollAfter?.scrollTop).toBe(96);
  });

  it('keeps Chat beside the same wide Schedule owner and restores its saved split after transient resize', async () => {
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    localStorage.setItem('cat-cafe:chatBasis', '62');
    const schedule = createWorkspaceModeSurface('product-schedule', 'test-thread');
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([schedule]) });
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1000 });
    try {
      await act(async () => root.render(renderChatContainer('test-thread')));
      const chat = container.querySelector<HTMLElement>('[data-testid="thread-chat-host"]');
      const owner = container.querySelector('[data-testid="workspace-panel"]');
      expect(chat?.style.flexBasis).toBe('62%');
      await act(async () =>
        useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(schedule.id, {
          kind: 'chat-workspace',
          threadId: 'test-thread',
          chatBasis: 30,
        }),
      );
      const host = container.querySelector<HTMLElement>('[data-testid="contextual-workspace-host"]');
      expect(host?.dataset.presentation).toBe('wide-workspace');
      expect(host?.className).not.toContain('absolute');
      expect(chat?.getAttribute('aria-hidden')).toBeNull();
      expect(chat?.className).not.toContain('invisible');
      expect(chat?.style.flexBasis).toBe('30%');
      expect(container.querySelector('[data-testid="workspace-panel"]')).toBe(owner);
      const handle = container.querySelector<HTMLElement>('[role="separator"][aria-label="右侧面板分隔条"]');
      if (!handle) throw new Error('wide Schedule retains the original accessible resize handle');
      await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      expect(chat?.style.flexBasis).not.toBe('30%');
      expect(localStorage.getItem('cat-cafe:chatBasis')).toBe('62');
      await act(async () => useF307ExperienceWorkbenchStore.getState().exitMainAreaAttention());
      expect(host?.dataset.presentation).toBe('right-rail');
      expect(chat?.style.flexBasis).toBe('62%');
      expect(container.querySelector('[data-testid="workspace-panel"]')).toBe(owner);
    } finally {
      if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDescriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    }
  });

  it('keeps the same Chat and owner DOM while an Artifact explicitly enters and exits full-window', async () => {
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    const opened = reduceArtifactWorkPresentation(createArtifactWorkPresentationState(), {
      type: 'begin',
      initiator: 'user',
      threadId: 'test-thread',
      surfaceId: REVIEW_SURFACE.id,
      returnHandle: {
        host: { owner: 'chat-container', key: 'test-thread' },
        workbench: { owner: 'f307', key: REVIEW_SURFACE.id },
        chatReadingRef: null,
        client: REVIEW_SURFACE.ownerStateRef,
      },
    }).state;
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([REVIEW_SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
      artifactWorkPresentation: opened,
    });
    await act(async () => root.render(renderChatContainer('test-thread')));

    const chatBefore = container.querySelector<HTMLElement>('[data-testid="thread-chat-host"]');
    const chatSurfaceBefore = container.querySelector<HTMLElement>('[data-thread-chat-surface]');
    const workspaceBefore = container.querySelector<HTMLElement>('[data-testid="workspace-panel"]');
    expect(chatBefore?.style.flexBasis).toBe('30%');

    const session = opened.session;
    if (!session) throw new Error('expected active Artifact presentation');
    await act(async () => {
      useF307ExperienceWorkbenchStore.getState().dispatchArtifactWorkPresentation({
        type: 'enter-full-window',
        initiator: 'user',
        generation: session.generation,
        threadId: session.threadId,
        surfaceId: session.surfaceId,
      });
    });

    const chatAfter = container.querySelector<HTMLElement>('[data-testid="thread-chat-host"]');
    const workspaceHost = container.querySelector<HTMLElement>('[data-testid="contextual-workspace-host"]');
    expect(chatAfter).toBe(chatBefore);
    expect(container.querySelector('[data-thread-chat-surface]')).toBe(chatSurfaceBefore);
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBe(workspaceBefore);
    expect(chatAfter?.dataset.presentation).toBe('artifact-full-window');
    expect(chatAfter?.getAttribute('aria-hidden')).not.toBe('true');
    expect(container.querySelector('[data-thread-chat-history]')?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('[data-testid="chat-input"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="header"]')).toBeNull();
    expect(workspaceHost?.dataset.presentation).toBe('artifact-full-window');
    expect(workspaceHost?.className).toContain('absolute');
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session?.mode).toBe('split');
    expect(container.querySelector('[data-testid="thread-chat-host"]')).toBe(chatBefore);
    expect(container.querySelector('[data-testid="workspace-panel"]')).toBe(workspaceBefore);
    expect(container.querySelector('[data-thread-chat-history]')?.hasAttribute('inert')).toBe(false);
  });

  it('invalidates an Artifact presentation when its real Thread host becomes ineligible', async () => {
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    const opened = reduceArtifactWorkPresentation(createArtifactWorkPresentationState(), {
      type: 'begin',
      initiator: 'user',
      threadId: 'test-thread',
      surfaceId: REVIEW_SURFACE.id,
      returnHandle: {
        host: { owner: 'chat-container', key: 'test-thread' },
        workbench: { owner: 'f307', key: REVIEW_SURFACE.id },
        chatReadingRef: null,
        client: REVIEW_SURFACE.ownerStateRef,
      },
    }).state;
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([REVIEW_SURFACE]),
      artifactWorkPresentation: opened,
    });
    await act(async () => root.render(renderChatContainer('test-thread')));
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session).not.toBeNull();

    mockRightPanelOpen = false;
    await act(async () => root.render(renderChatContainer('test-thread')));
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session).toBeNull();
  });

  it('ends transient main-area attention when Chat switches to split view', async () => {
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([PROGRAM_SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: PROGRAM_SURFACE.id,
    });
    await act(async () => {
      root.render(renderChatContainer('test-thread'));
    });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(PROGRAM_SURFACE.id);

    mockViewMode = 'split';
    await act(async () => {
      root.render(renderChatContainer('test-thread'));
    });

    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('auto-opens sidebar store on desktop but does not render mobile overlay', () => {
    mockMatchMedia(true);
    act(() => {
      root.render(renderChatContainer('test-thread'));
    });
    expect(useSidebarStore.getState().isOpen).toBe(true);
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
  });

  async function mountArtifactFullWindow() {
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    const opened = reduceArtifactWorkPresentation(createArtifactWorkPresentationState(), {
      type: 'begin',
      initiator: 'user',
      threadId: 'test-thread',
      surfaceId: REVIEW_SURFACE.id,
      returnHandle: {
        host: { owner: 'chat-container', key: 'test-thread' },
        workbench: { owner: 'f307', key: REVIEW_SURFACE.id },
        chatReadingRef: null,
        client: REVIEW_SURFACE.ownerStateRef,
      },
    }).state;
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([REVIEW_SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
      artifactWorkPresentation: opened,
    });
    await act(async () => root.render(renderChatContainer('test-thread')));
    const session = opened.session;
    if (!session) throw new Error('expected session');
    await act(async () => {
      useF307ExperienceWorkbenchStore.getState().dispatchArtifactWorkPresentation({
        type: 'enter-full-window',
        initiator: 'user',
        generation: session.generation,
        threadId: session.threadId,
        surfaceId: session.surfaceId,
      });
    });
    expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session?.mode).toBe('full-window');
  }
  const artifactPresentationMode = () =>
    useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session?.mode;

  it('leaves Artifact full-window on an unclaimed Escape from the composer', async () => {
    await mountArtifactFullWindow();
    const composer = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
    if (!composer) throw new Error('composer missing');
    await act(async () =>
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    );
    expect(artifactPresentationMode()).toBe('split');
  });

  it('keeps Artifact full-window when an inner owner already handled Escape', async () => {
    await mountArtifactFullWindow();
    const composer = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
    if (!composer) throw new Error('composer missing');
    composer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') event.preventDefault();
    });
    await act(async () =>
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    );
    expect(artifactPresentationMode()).toBe('full-window');
  });

  it('keeps Artifact full-window when Escape cancels an IME composition', async () => {
    await mountArtifactFullWindow();
    const composer = container.querySelector<HTMLElement>('[data-testid="chat-input"]');
    if (!composer) throw new Error('composer missing');
    await act(async () =>
      composer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }),
      ),
    );
    expect(artifactPresentationMode()).toBe('full-window');
  });

  it('keeps Artifact full-window when an interactive fullscreen overlay owns Escape', async () => {
    await mountArtifactFullWindow();
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0';
    document.body.appendChild(overlay);
    try {
      await act(async () =>
        overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
      );
      expect(artifactPresentationMode()).toBe('full-window');
    } finally {
      overlay.remove();
    }
  });

  async function dragRightPanelHandle(mode: 'workspace' | 'transcript', withArtifact: boolean) {
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = mode;
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(withArtifact ? [REVIEW_SURFACE] : []),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
      artifactWorkPresentation: createArtifactWorkPresentationState(),
    });
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1000 });
    try {
      await act(async () => root.render(renderChatContainer('test-thread')));
      const host = () => container.querySelector<HTMLElement>('[data-testid="thread-chat-host"]');
      const handle = container.querySelector<HTMLElement>('[role="separator"][aria-label="右侧面板分隔条"]');
      if (!handle) throw new Error(`right panel separator not rendered in mode ${mode}`);
      const before = host()?.style.flexBasis;
      const artifactBefore = useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.desktopWorkChatBasis;
      await act(async () =>
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })),
      );
      return {
        before,
        after: host()?.style.flexBasis,
        artifactBefore,
        artifactAfter: useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.desktopWorkChatBasis,
      };
    } finally {
      if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDescriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    }
  }

  it('keeps a v2 browser on the original Chat split preference and resize owner', async () => {
    mockMatchMedia(true);
    mockRightPanelOpen = true;
    mockRightPanelMode = 'workspace';
    localStorage.setItem('cat-cafe:chatBasis', '62');
    writeShellPresentation('v2');
    const browser = createBrowserSurface({ ownerKey: 'browser-ratio', port: 5324, path: '/browser-owner-probe' });
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([browser]),
      artifactWorkPresentation: createArtifactWorkPresentationState(37),
    });
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1000 });
    try {
      await act(async () => root.render(renderChatContainer('test-thread')));
      const chat = container.querySelector<HTMLElement>('[data-testid="thread-chat-host"]');
      expect(chat?.style.flexBasis).toBe('62%');
      const handle = container.querySelector<HTMLElement>('[role="separator"][aria-label="右侧面板分隔条"]');
      if (!handle) throw new Error('the normal browser split needs its original resize handle');
      await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      expect(chat?.style.flexBasis).not.toBe('62%');
      expect(useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.desktopWorkChatBasis).toBe(37);
    } finally {
      if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDescriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    }
  });

  it('resizes the visible Chat basis in transcript mode without an Artifact', async () => {
    const result = await dragRightPanelHandle('transcript', false);
    expect(result.after).not.toBe(result.before);
    expect(result.artifactAfter).toBe(result.artifactBefore);
  });

  it('resizes the visible Artifact work basis in workspace mode', async () => {
    const result = await dragRightPanelHandle('workspace', true);
    expect(result.after).not.toBe(result.before);
    expect(result.artifactAfter).not.toBe(result.artifactBefore);
  });

  it('resizes only the visible Chat basis when transcript mode retains an inactive Artifact host', async () => {
    const result = await dragRightPanelHandle('transcript', true);
    expect(result.after).not.toBe(result.before);
    expect(result.artifactAfter).toBe(result.artifactBefore);
  });
});
