/**
 * Thread indicator in ChatContainerHeader.
 * Verifies that the header shows the current thread title (not just "Clowder AI").
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));

const TEST_THREADS = [
  {
    id: 'thread_xyz',
    title: '讨论 F095 设计',
    projectPath: '/projects/cat-cafe',
    createdBy: 'user1',
    participants: ['user1'],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    pinned: false,
    favorited: false,
    preferredCats: [] as string[],
  },
];

const mockStore: Record<string, unknown> = {
  threads: TEST_THREADS,
  rightPanelMode: 'status',
  setRightPanelMode: vi.fn(),
};
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore },
  );
  return { useChatStore: hook };
});

const defaultProps = {
  sidebarOpen: false,
  onToggleSidebar: vi.fn(),
  authPendingCount: 0,
  viewMode: 'single' as const,
  onToggleViewMode: vi.fn(),
  onOpenMobileStatus: vi.fn(),
  statusPanelOpen: false,
  onToggleStatusPanel: vi.fn(),
  defaultCatId: 'opus',
};

describe('ChatContainerHeader thread indicator', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows "大厅" when threadId is default', () => {
    act(() => {
      root.render(React.createElement(ChatContainerHeader, { ...defaultProps, threadId: 'default' }));
    });

    expect(container.textContent).toContain('大厅');
  });

  it('shows thread title and project name when a specific thread is selected', () => {
    act(() => {
      root.render(React.createElement(ChatContainerHeader, { ...defaultProps, threadId: 'thread_xyz' }));
    });

    expect(container.textContent).toContain('讨论 F095 设计');
    expect(container.textContent).toContain('cat-cafe');
  });

  it('shows "未命名对话" when thread has no title', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_no_title', title: null }];
    act(() => {
      root.render(React.createElement(ChatContainerHeader, { ...defaultProps, threadId: 'thread_no_title' }));
    });

    expect(container.textContent).toContain('未命名对话');
  });

  it('hides sentinel projectPath "default" from thread label', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_sentinel', projectPath: 'default' }];
    act(() => {
      root.render(React.createElement(ChatContainerHeader, { ...defaultProps, threadId: 'thread_sentinel' }));
    });

    expect(container.textContent).toContain('讨论 F095 设计');
    expect(container.textContent).not.toContain('default');
  });

  it('preserves "default" label for real path ending in /default', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_real_default', projectPath: '/tmp/default' }];
    act(() => {
      root.render(React.createElement(ChatContainerHeader, { ...defaultProps, threadId: 'thread_real_default' }));
    });

    expect(container.textContent).toContain('讨论 F095 设计');
    expect(container.textContent).toContain('default');
  });

  it('extracts basename from Windows backslash path', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_win', projectPath: 'C:\\Users\\dev\\my-app' }];
    act(() => {
      root.render(React.createElement(ChatContainerHeader, { ...defaultProps, threadId: 'thread_win' }));
    });

    expect(container.textContent).toContain('my-app');
  });

  it('maps internal basename to brand name when NEXT_PUBLIC_BRAND_NAME is set', () => {
    const origEnv = process.env.NEXT_PUBLIC_BRAND_NAME;
    process.env.NEXT_PUBLIC_BRAND_NAME = 'Clowder AI';
    try {
      mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_brand', projectPath: '/home/user/cat-cafe' }];
      act(() => {
        root.render(React.createElement(ChatContainerHeader, { ...defaultProps, threadId: 'thread_brand' }));
      });

      expect(container.textContent).toContain('Clowder AI');
      expect(container.textContent).not.toContain('cat-cafe');
    } finally {
      if (origEnv === undefined) delete process.env.NEXT_PUBLIC_BRAND_NAME;
      else process.env.NEXT_PUBLIC_BRAND_NAME = origEnv;
    }
  });
});
