import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadItem } from '@/components/ThreadSidebar/ThreadItem';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: (catId: string) => ({ displayName: catId === 'cat-a' ? '猫甲' : catId }),
    getCatsByBreed: () => new Map(),
  }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));

vi.mock('@/components/ThreadCatStatus', () => ({
  ThreadCatStatus: () => null,
}));

vi.mock('@/components/ThreadSidebar/ThreadCatSettings', () => ({
  ThreadCatSettings: ({
    triggerIcon,
    triggerLabel,
    triggerRole,
  }: {
    triggerIcon?: React.ReactNode;
    triggerLabel?: string;
    triggerRole?: 'menuitem';
  }) =>
    React.createElement(
      'button',
      { role: triggerRole, title: '设置默认猫猫', type: 'button' },
      triggerIcon,
      React.createElement('span', null, triggerLabel ?? '设置默认猫猫'),
    ),
}));

vi.mock('@/components/ThreadSidebar/ThreadLabelPicker', () => ({
  ThreadLabelPicker: ({
    triggerIcon,
    triggerLabel,
    triggerRole,
  }: {
    triggerIcon?: React.ReactNode;
    triggerLabel?: string;
    triggerRole?: 'menuitem';
  }) =>
    React.createElement(
      'button',
      { role: triggerRole, title: '标签管理', type: 'button' },
      triggerIcon,
      React.createElement('span', null, triggerLabel ?? '标签管理'),
    ),
}));

vi.mock('@/components/icons/HubIcon', () => ({
  HubIcon: () => React.createElement('span', null, 'hub'),
}));

vi.mock('@/components/icons/PawIcon', () => ({
  PawIcon: () => React.createElement('span', null, 'paw'),
}));

vi.mock('@/components/ThreadSidebar/thread-utils', () => ({
  formatRelativeTime: () => '1分',
}));

vi.mock('@/stores/label-store', () => ({
  useLabelStore: () => ({
    labels: [
      { id: 'product', name: '产品体验', color: '#3b82f6' },
      { id: 'architecture', name: '架构规划', color: '#8b5cf6' },
      { id: 'bug', name: '缺陷排查', color: '#ef4444' },
      { id: 'quality', name: '评测质控', color: '#10b981' },
    ],
  }),
}));

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://example.test',
  apiFetch: vi.fn(),
}));

describe('ThreadItem actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
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
    vi.restoreAllMocks();
  });

  function renderThread(overrides: Partial<React.ComponentProps<typeof ThreadItem>> = {}) {
    act(() => {
      root.render(
        React.createElement(ThreadItem, {
          id: 'thread-1',
          title: 'Thread 1',
          participants: ['cat-a'],
          lastActiveAt: 1,
          isActive: false,
          onSelect: vi.fn(),
          onDelete: vi.fn(),
          onRename: vi.fn(),
          onTogglePin: vi.fn(),
          onToggleFavorite: vi.fn(),
          onUpdatePreferredCats: vi.fn(),
          onUpdateLabels: vi.fn(),
          projectPath: '/projects/cat-cafe',
          isPinned: false,
          isFavorited: false,
          threadLabels: [],
          ...overrides,
        }),
      );
    });
  }

  function buttonByTitle(title: string): HTMLButtonElement | null {
    return container.querySelector(`button[title="${title}"]`);
  }

  it('keeps pin and delete inside the more menu instead of fixed row buttons', () => {
    renderThread();

    expect(buttonByTitle('置顶')).toBeNull();
    expect(buttonByTitle('删除对话')).toBeNull();
    expect(buttonByTitle('更多操作')).not.toBeNull();
    expect(buttonByTitle('更多操作')?.className).not.toContain('opacity-0');

    expect(buttonByTitle('设置默认猫猫')).toBeNull();
    expect(buttonByTitle('重命名对话')).toBeNull();
    expect(buttonByTitle('导出对话')).toBeNull();
    expect(buttonByTitle('标签管理')).toBeNull();
    expect(buttonByTitle('收藏')).toBeNull();
  });

  it('keeps the project path in the thread hover tooltip', () => {
    renderThread();

    const item = container.querySelector('[data-thread-id="thread-1"]');
    expect(item?.getAttribute('title')).toContain('路径: /projects/cat-cafe');
  });

  it('shows secondary actions inside the more menu', () => {
    renderThread();

    act(() => {
      buttonByTitle('更多操作')?.click();
    });

    const menu = container.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('置顶');
    expect(menu?.textContent).toContain('删除对话');
    expect(menu?.textContent).toContain('设置默认猫猫');
    expect(menu?.textContent).toContain('重命名对话');
    expect(menu?.textContent).toContain('导出对话');
    expect(menu?.textContent).toContain('标签管理');
    expect(menu?.textContent).toContain('收藏');
  });

  it('renders secondary actions as icon plus text menu items', () => {
    renderThread();

    act(() => {
      buttonByTitle('更多操作')?.click();
    });

    const menu = container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();

    for (const label of ['置顶', '设置默认猫猫', '重命名对话', '导出对话', '标签管理', '收藏', '删除对话']) {
      const item = Array.from(menu!.querySelectorAll('[role="menuitem"]')).find((el) =>
        el.textContent?.includes(label),
      );
      expect(item, `${label} menu item`).not.toBeUndefined();
      const first = item!.firstElementChild;
      expect(first?.querySelector('svg[aria-hidden="true"]') ?? first?.matches('svg[aria-hidden="true"]')).toBeTruthy();
      expect(item!.textContent).toContain(label);
    }
  });

  it('shows a filled favorite mark next to favorited thread titles', () => {
    renderThread({ isFavorited: true });

    const mark = container.querySelector('[data-testid="thread-favorite-mark"]');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute('aria-label')).toBe('已收藏');
  });

  it('renders labels as one 16px compact tag button with overflow dots', () => {
    renderThread({ threadLabels: ['product', 'architecture', 'bug', 'quality'] });

    const labelButton = container.querySelector('[data-testid="thread-label-dots"]');
    expect(labelButton).not.toBeNull();
    expect(labelButton?.className).toContain('h-4');
    expect(labelButton?.getAttribute('title')).toBe('产品体验, 架构规划, 缺陷排查, 评测质控');
    expect(labelButton?.textContent).toContain('+1');
  });

  it('keeps the full code-compatible tooltip format on the thread item', () => {
    renderThread({ participants: ['cat-a'], projectPath: '/projects/cat-cafe' });

    const item = container.querySelector('[data-thread-id="thread-1"]');
    expect(item?.getAttribute('title')).toContain('Thread 1');
    expect(item?.getAttribute('title')).toContain('参与: 猫甲');
    expect(item?.getAttribute('title')).toContain('路径: /projects/cat-cafe');
    expect(item?.getAttribute('title')).toContain('1分');
  });
});
