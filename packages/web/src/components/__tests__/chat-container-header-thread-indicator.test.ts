/**
 * Thread indicator in ChatContainerHeader.
 * Verifies that the header shows the current thread title (not just "Clowder AI").
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));
vi.mock('@/components/ThreadCatPill', () => ({
  ThreadCatPill: () => null,
}));
vi.mock('@/components/ExportButton', () => ({
  ExportButton: () => null,
}));
vi.mock('@/components/HubButton', () => ({
  HubButton: () => null,
}));
vi.mock('@/components/ThemeToggle', () => ({
  ThemeToggle: () => null,
}));
vi.mock('@/components/VoiceCompanionButton', () => ({
  VoiceCompanionButton: () => null,
}));
vi.mock('@/components/icons/CatCafeLogo', () => ({
  CatCafeLogo: () => React.createElement('span', null, 'logo'),
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

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  const renderHeader = (threadId: string) => {
    container.innerHTML = renderToStaticMarkup(React.createElement(ChatContainerHeader, { ...defaultProps, threadId }));
    return container;
  };

  it('shows "大厅" when threadId is default', () => {
    expect(renderHeader('default').textContent).toContain('大厅');
  });

  it('shows thread title and project name when a specific thread is selected', () => {
    const rendered = renderHeader('thread_xyz');
    expect(rendered.textContent).toContain('讨论 F095 设计');
    expect(rendered.textContent).toContain('cat-cafe');
  });

  it('shows "未命名对话" when thread has no title', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_no_title', title: null }];
    expect(renderHeader('thread_no_title').textContent).toContain('未命名对话');
  });

  it('hides sentinel projectPath "default" from thread label', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_sentinel', projectPath: 'default' }];
    const rendered = renderHeader('thread_sentinel');
    expect(rendered.textContent).toContain('讨论 F095 设计');
    expect(rendered.textContent).not.toContain('default');
  });

  it('preserves "default" label for real path ending in /default', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_real_default', projectPath: '/tmp/default' }];
    const rendered = renderHeader('thread_real_default');
    expect(rendered.textContent).toContain('讨论 F095 设计');
    expect(rendered.textContent).toContain('default');
  });

  it('extracts basename from Windows backslash path', () => {
    mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_win', projectPath: 'C:\\Users\\dev\\my-app' }];
    expect(renderHeader('thread_win').textContent).toContain('my-app');
  });

  it('maps internal basename to brand name when NEXT_PUBLIC_BRAND_NAME is set', () => {
    const origEnv = process.env.NEXT_PUBLIC_BRAND_NAME;
    process.env.NEXT_PUBLIC_BRAND_NAME = 'Clowder AI';
    try {
      mockStore.threads = [{ ...TEST_THREADS[0], id: 'thread_brand', projectPath: '/home/user/cat-cafe' }];
      const rendered = renderHeader('thread_brand');
      expect(rendered.textContent).toContain('Clowder AI');
      expect(rendered.textContent).not.toContain('cat-cafe');
    } finally {
      if (origEnv === undefined) delete process.env.NEXT_PUBLIC_BRAND_NAME;
      else process.env.NEXT_PUBLIC_BRAND_NAME = origEnv;
    }
  });
});
