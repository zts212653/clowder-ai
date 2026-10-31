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

vi.mock('@/components/ThreadSidebar/ThreadSettingsPanel', () => ({
  ThreadSettingsPanel: ({ open }: { open: boolean }) =>
    open
      ? React.createElement(
          'aside',
          { 'data-testid': 'thread-settings-panel', 'data-thread-settings-panel': 'true' },
          React.createElement('button', { type: 'button' }, '面板内操作'),
        )
      : null,
}));

vi.mock('@/components/icons/HubIcon', () => ({
  HubIcon: () => React.createElement('span', null, 'hub'),
}));

vi.mock('@/components/icons/PawIcon', () => ({
  PawIcon: () => React.createElement('span', null, 'paw'),
}));

vi.mock('@/components/ThreadSidebar/thread-utils', () => ({
  formatRelativeTime: () => '1分',
  formatSidebarStatusTime: () => '1分',
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
          presence: { status: 'idle' },
          unreadCount: 0,
          hasUserMention: false,
          ...overrides,
        }),
      );
    });
  }

  function buttonByTitle(title: string): HTMLButtonElement | null {
    return container.querySelector(`button[title="${title}"]`);
  }

  it('shows a single inline pin button in the title area, not duplicated', () => {
    renderThread();

    // Pin button is inline in the title area (data-testid), not a separate button next to ⋮
    const pinButton = container.querySelector('[data-testid="thread-pin-button"]');
    expect(pinButton).not.toBeNull();
    expect(pinButton?.getAttribute('title')).toBe('置顶');

    // Only ONE pin icon in the entire thread item — no duplicate
    const allPinSvgs = container.querySelectorAll('[data-testid="thread-pin-button"]');
    expect(allPinSvgs.length).toBe(1);

    // Delete stays in the menu
    expect(buttonByTitle('删除对话')).toBeNull();
    expect(buttonByTitle('更多操作')).not.toBeNull();
  });

  it('shows pin button with accent color when pinned, hover-revealed when unpinned', () => {
    // Pinned: accent, always visible
    renderThread({ isPinned: true });
    const pinnedBtn = container.querySelector('[data-testid="thread-pin-button"]');
    expect(pinnedBtn?.className).toContain('text-cafe-accent');
    expect(pinnedBtn?.className).not.toContain('opacity-0');
    expect(pinnedBtn?.getAttribute('title')).toBe('取消置顶');

    // Unpinned: hover-revealed, muted
    renderThread({ isPinned: false });
    const unpinnedBtn = container.querySelector('[data-testid="thread-pin-button"]');
    expect(unpinnedBtn?.className).toContain('opacity-0');
    expect(unpinnedBtn?.className).toContain('group-hover:opacity-100');
    expect(unpinnedBtn?.className).toContain('focus-visible:opacity-100');
    expect(unpinnedBtn?.className).toContain('[@media(hover:none)]:opacity-100');
    expect(unpinnedBtn?.getAttribute('aria-label')).toBe('置顶 Thread 1');
    expect(unpinnedBtn?.getAttribute('title')).toBe('置顶');
  });

  it('keeps a pinned indicator when pinning is read-only', () => {
    renderThread({ isPinned: true, onTogglePin: undefined });

    expect(container.querySelector('[data-testid="thread-pin-button"]')).toBeNull();
    expect(container.querySelector('[role="img"][aria-label="已置顶"]')).not.toBeNull();
  });

  it('keeps the project path in the thread hover tooltip', () => {
    renderThread();

    const item = container.querySelector('[data-thread-id="thread-1"]');
    const title = item?.querySelector('span[title*="路径: /projects/cat-cafe"]');
    expect(item?.getAttribute('title')).toBeNull();
    expect(title).not.toBeNull();
  });

  it('shows secondary actions inside the more menu', () => {
    renderThread();

    act(() => {
      buttonByTitle('更多操作')?.click();
    });

    const menu = container.querySelector('[role="menu"]');
    // Pin is NOT in the menu (it's a fixed button outside)
    expect(menu?.textContent).not.toContain('置顶');
    expect(menu?.textContent).toContain('删除对话');
    expect(menu?.textContent).toContain('对话设置');
    expect(menu?.textContent).not.toContain('设置默认猫猫');
    expect(menu?.textContent).not.toContain('思考档位');
    expect(menu?.textContent).not.toContain('速度档位');
    expect(menu?.textContent).not.toContain('标签管理');
    expect(menu?.textContent).toContain('重命名对话');
    expect(menu?.textContent).toContain('导出对话');
    expect(menu?.textContent).toContain('收藏');
  });

  it('renders secondary actions as icon plus text menu items', () => {
    renderThread();

    act(() => {
      buttonByTitle('更多操作')?.click();
    });

    const menu = container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();

    for (const label of ['对话设置', '重命名对话', '导出对话', '收藏', '删除对话']) {
      const item = Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []).find((el) =>
        el.textContent?.includes(label),
      );
      expect(item, `${label} menu item`).not.toBeUndefined();
      const first = item?.firstElementChild;
      expect(first?.querySelector('svg[aria-hidden="true"]') ?? first?.matches('svg[aria-hidden="true"]')).toBeTruthy();
      expect(item?.textContent).toContain(label);
    }
  });

  it('closes the short action menu before opening the unified settings surface', () => {
    renderThread();

    act(() => {
      buttonByTitle('更多操作')?.click();
    });
    const settingsItem = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent === '对话设置',
    ) as HTMLButtonElement | undefined;

    act(() => settingsItem?.click());

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-settings-panel"]')).not.toBeNull();
  });

  it('does not select the thread when using controls inside the portaled settings surface', () => {
    const onSelect = vi.fn();
    renderThread({ onSelect });

    act(() => buttonByTitle('更多操作')?.click());
    const settingsItem = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent === '对话设置',
    ) as HTMLButtonElement | undefined;
    act(() => settingsItem?.click());
    act(() => {
      const panelControl = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === '面板内操作',
      );
      panelControl?.click();
    });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows a filled favorite mark next to favorited thread titles', () => {
    renderThread({ isFavorited: true });

    const mark = container.querySelector('[data-testid="thread-favorite-mark"]');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute('aria-label')).toBe('已收藏');
  });

  it('shows a visible system marker for a cat bedroom', () => {
    renderThread({ systemKind: 'cat_bedroom' });

    const marker = container.querySelector('[data-testid="thread-system-kind"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toBe('猫卧室');
    expect(marker?.getAttribute('title')).toBe('猫的私人卧室');
  });

  it('renders labels as one 16px compact tag button with overflow dots', () => {
    renderThread({ threadLabels: ['product', 'architecture', 'bug', 'quality'] });

    const labelButton = container.querySelector('[data-testid="thread-label-dots"]');
    expect(labelButton).not.toBeNull();
    expect(labelButton?.className).toContain('h-4');
    expect(labelButton?.getAttribute('title')).toBe('产品体验, 架构规划, 缺陷排查, 评测质控');
    expect(labelButton?.textContent).toContain('+1');
  });

  it('renders title with rebalanced styling fixture (clowder-ai#1305)', () => {
    renderThread({ title: 'A very long thread title that should wrap to two lines in the sidebar' });

    const titleSpan = container.querySelector('[data-thread-id="thread-1"] span span:last-child');
    expect(titleSpan).not.toBeNull();
    expect(titleSpan?.className).toContain('line-clamp-2');
    expect(titleSpan?.className).toContain('text-sm');
    expect(titleSpan?.className).toContain('leading-normal');
    expect(titleSpan?.className).not.toContain('leading-snug');
    expect(titleSpan?.className).not.toContain('truncate');
    expect(titleSpan?.className).not.toContain('text-xs');
  });

  it('uses font-medium not font-semibold for active title (clowder-ai#1305 follow-up)', () => {
    renderThread({ title: 'Active thread', isActive: true });

    const titleSpan = container.querySelector('[data-thread-id="thread-1"] span span:last-child');
    expect(titleSpan?.className).toContain('font-medium');
    expect(titleSpan?.className).not.toContain('font-semibold');
  });

  it('uses py-2.5 card padding for vertical breathing room (clowder-ai#1305 follow-up)', () => {
    renderThread({ title: 'Test' });

    const card = container.querySelector('[data-thread-id="thread-1"]');
    expect(card?.className).toContain('py-2.5');
    expect(card?.className).not.toContain('py-2 ');
    expect(card?.className).not.toMatch(/py-2(?!\.)/);
  });

  it('keeps the full code-compatible tooltip format on the thread item', () => {
    renderThread({ participants: ['cat-a'], projectPath: '/projects/cat-cafe' });

    const item = container.querySelector('[data-thread-id="thread-1"]');
    const title = item?.querySelector('span[title*="Thread 1"]');
    expect(item?.getAttribute('title')).toBeNull();
    expect(title?.getAttribute('title')).toContain('Thread 1');
    expect(title?.getAttribute('title')).toContain('参与: 猫甲');
    expect(title?.getAttribute('title')).toContain('路径: /projects/cat-cafe');
    expect(title?.getAttribute('title')).toContain('1分');
  });
});
