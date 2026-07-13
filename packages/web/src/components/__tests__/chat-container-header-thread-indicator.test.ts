/**
 * Thread indicator in ChatContainerHeader.
 * Verifies that the header shows the current thread title (not just "Clowder AI").
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainerHeader, ThreadIndicator, tailTruncate } from '@/components/ChatContainerHeader';

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
vi.mock('@/components/ChatVoiceFeatureControls', () => ({
  ChatVoiceFeatureControls: () => null,
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
  let root: Root | null;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
    mockStore.threads = TEST_THREADS;
    mockStore.rightPanelMode = 'status';
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
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

  it('splits title and project chip into flex siblings so long titles do not eat the project label', () => {
    mockStore.threads = [
      {
        ...TEST_THREADS[0],
        title: 'A'.repeat(120),
        projectPath: '/home/user/workspace/AI/clowder-ai',
      },
    ];
    const html = renderToStaticMarkup(React.createElement(ThreadIndicator, { threadId: 'thread_xyz' }));

    expect(html).toMatch(/class="flex min-w-0[^"]*"/);
    expect(html).toMatch(/<span class="truncate min-w-0[^"]*"[^>]*>A{120}<\/span>/);
    expect(html).toContain('flex-shrink-0');
    expect(html).toContain('· clowder-ai');
  });

  it('bounds the project chip and tail-truncates long basenames while preserving the full path tooltip', () => {
    const longBasename = 'cat-cafe-experimental-feature-with-extremely-verbose-name';
    mockStore.threads = [
      {
        ...TEST_THREADS[0],
        title: 't',
        projectPath: `/home/user/workspace/AI/${longBasename}`,
      },
    ];
    const html = renderToStaticMarkup(React.createElement(ThreadIndicator, { threadId: 'thread_xyz' }));

    expect(html).toContain('max-w-[40%]');
    expect(html).toContain('sm:max-w-[200px]');
    expect(html).toContain('overflow-hidden');
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain(longBasename.slice(-10));
    expect(html).toMatch(/·\s+…/);
    expect(html).toContain(`/home/user/workspace/AI/${longBasename}`);
  });

  it('does not throw when navigator.clipboard is unavailable or writeText rejects', async () => {
    mockStore.threads = [{ ...TEST_THREADS[0], projectPath: '/home/user/workspace/AI/clowder-ai' }];
    root = createRoot(container);

    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    act(() => root?.render(React.createElement(ThreadIndicator, { threadId: 'thread_xyz' })));
    expect(() => act(() => (container.querySelector('[role="button"]') as HTMLElement | null)?.click())).not.toThrow();

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () => {
          throw new Error('NotAllowedError');
        },
      },
      configurable: true,
    });
    expect(() => act(() => (container.querySelector('[role="button"]') as HTMLElement | null)?.click())).not.toThrow();

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    await expect(
      act(async () => {
        (container.querySelector('[role="button"]') as HTMLElement | null)?.click();
      }),
    ).resolves.toBeUndefined();
  });

  it('shows click-to-copy hint and copied feedback for the project path chip', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      root = createRoot(container);
      await act(async () => {
        root?.render(React.createElement(ThreadIndicator, { threadId: 'thread_xyz' }));
      });

      // The title span also has role="button" now (double-click to edit),
      // so grab the project chip specifically via aria-label
      const projectChip = container.querySelector('[role="button"][aria-label*="项目路径"]') as HTMLElement | null;
      expect(projectChip?.getAttribute('title')).toBe('点击复制: /projects/cat-cafe');

      await act(async () => {
        projectChip?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith('/projects/cat-cafe');
      expect(projectChip?.textContent).toContain('copied!');

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(projectChip?.textContent).toContain('cat-cafe');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets copied feedback when switching threads', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockStore.threads = [
      TEST_THREADS[0],
      {
        ...TEST_THREADS[0],
        id: 'thread_next',
        title: '另一个对话',
        projectPath: '/projects/next-app',
      },
    ];
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      root = createRoot(container);
      await act(async () => {
        root?.render(React.createElement(ThreadIndicator, { threadId: 'thread_xyz' }));
      });

      const projectChip = container.querySelector('[role="button"][aria-label*="项目路径"]') as HTMLElement | null;
      await act(async () => {
        projectChip?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(projectChip?.textContent).toContain('copied!');

      await act(async () => {
        root?.render(React.createElement(ThreadIndicator, { threadId: 'thread_next' }));
      });

      const nextProjectChip = container.querySelector('[role="button"][aria-label*="项目路径"]') as HTMLElement | null;
      expect(nextProjectChip?.textContent).toContain('next-app');
      expect(nextProjectChip?.textContent).not.toContain('copied!');
      expect(nextProjectChip?.getAttribute('title')).toBe('点击复制: /projects/next-app');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tailTruncate preserves short names and leading-ellipsis truncates long names', () => {
    expect(tailTruncate('clowder-ai')).toBe('clowder-ai');
    expect(tailTruncate('a'.repeat(24))).toBe('a'.repeat(24));
    expect(tailTruncate('a'.repeat(40), 24)).toBe(`…${'a'.repeat(23)}`);
    expect(tailTruncate('cat-cafe-experimental-build-2026-spring', 24)).toBe('…ental-build-2026-spring');
  });
});
