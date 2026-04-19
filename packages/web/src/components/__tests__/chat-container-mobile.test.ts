import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

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

// Stub child components to isolate ChatContainer behavior
vi.mock('../ChatMessage', () => ({ ChatMessage: () => null }));
vi.mock('../ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../ChatContainerHeader', () => ({
  ChatContainerHeader: (props: { onToggleSidebar: () => void; onOpenMobileStatus: () => void }) =>
    React.createElement(
      'div',
      { 'data-testid': 'header' },
      React.createElement('button', { 'data-testid': 'sidebar-toggle', onClick: props.onToggleSidebar }),
      React.createElement('button', { 'data-testid': 'mobile-status-trigger', onClick: props.onOpenMobileStatus }),
    ),
}));
vi.mock('../ThreadSidebar', () => ({
  ThreadSidebar: (props: { onClose: () => void }) =>
    React.createElement('div', { 'data-testid': 'sidebar', onClick: props.onClose }, 'Sidebar'),
}));
vi.mock('../RightStatusPanel', () => ({ RightStatusPanel: () => null }));
vi.mock('../MobileStatusSheet', () => ({
  MobileStatusSheet: (props: { open: boolean }) =>
    React.createElement('div', { 'data-testid': 'mobile-status', 'data-open': String(props.open) }),
}));
vi.mock('../ParallelStatusBar', () => ({ ParallelStatusBar: () => null }));
vi.mock('../ThinkingIndicator', () => ({ ThinkingIndicator: () => null }));
vi.mock('../MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('../MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../CatCafeHub', () => ({ CatCafeHub: () => null }));
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockMatchMedia(false); // default: mobile
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

  it('opens sidebar overlay when toggle button is clicked', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    const toggleBtn = container.querySelector('[data-testid="sidebar-toggle"]') as HTMLButtonElement;
    act(() => {
      toggleBtn.click();
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeTruthy();
    // Backdrop should also appear
    expect(container.querySelector('[class*="bg-black"]')).toBeTruthy();
  });

  it('closes sidebar when backdrop is clicked', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    // Open sidebar
    const toggleBtn = container.querySelector('[data-testid="sidebar-toggle"]') as HTMLButtonElement;
    act(() => {
      toggleBtn.click();
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeTruthy();
    // Click backdrop
    const backdrop = container.querySelector('[class*="bg-black"]') as HTMLElement;
    act(() => {
      backdrop.click();
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
  });

  it('mobile status sheet starts closed and opens on trigger', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    const statusSheet = container.querySelector('[data-testid="mobile-status"]') as HTMLElement;
    expect(statusSheet.getAttribute('data-open')).toBe('false');

    const triggerBtn = container.querySelector('[data-testid="mobile-status-trigger"]') as HTMLButtonElement;
    act(() => {
      triggerBtn.click();
    });

    const statusSheetAfter = container.querySelector('[data-testid="mobile-status"]') as HTMLElement;
    expect(statusSheetAfter.getAttribute('data-open')).toBe('true');
  });

  it('auto-opens sidebar on desktop viewport', () => {
    mockMatchMedia(true);
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'test-thread' }));
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeTruthy();
  });
});
