import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadItem } from '@/components/ThreadSidebar/ThreadItem';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: () => undefined,
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

  function renderThread() {
    act(() => {
      root.render(
        React.createElement(ThreadItem, {
          id: 'thread-1',
          title: 'Thread 1',
          participants: [],
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
        }),
      );
    });
  }

  function buttonByTitle(title: string): HTMLButtonElement | null {
    return container.querySelector(`button[title="${title}"]`);
  }

  it('keeps direct thread actions to pin, delete, and more', () => {
    renderThread();

    expect(buttonByTitle('置顶')).not.toBeNull();
    expect(buttonByTitle('删除对话')).not.toBeNull();
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

    for (const label of ['设置默认猫猫', '重命名对话', '导出对话', '标签管理', '收藏']) {
      const item = Array.from(menu!.querySelectorAll('[role="menuitem"]')).find((el) =>
        el.textContent?.includes(label),
      );
      expect(item, `${label} menu item`).not.toBeUndefined();
      const first = item!.firstElementChild;
      expect(first?.querySelector('svg[aria-hidden="true"]') ?? first?.matches('svg[aria-hidden="true"]')).toBeTruthy();
      expect(item!.textContent).toContain(label);
    }
  });
});
