import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/stores/chat-types';
import { useLabelStore } from '@/stores/label-store';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockPush,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const NOW = 1710000000000;

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    projectPath: 'default',
    title: null,
    createdBy: 'user',
    participants: [],
    lastActiveAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function visibleThreadIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-thread-id]')).map(
    (node) => node.getAttribute('data-thread-id') ?? '',
  );
}

async function clickTab(container: HTMLElement, tabId: string, flush: () => Promise<void>) {
  const tab = container.querySelector(`[data-testid="sidebar-tab-${tabId}"]`) as HTMLButtonElement;
  await act(async () => {
    tab.click();
  });
  await flush();
}

describe('ThreadSidebar v9 tab redesign', () => {
  let harness: ThreadSidebarHarness;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    });
    Object.assign(mockStore, {
      threads: [
        makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
        makeThread({ id: 'recent', title: 'Recent Thread', projectPath: '/proj/b', lastActiveAt: NOW - 1_000 }),
        makeThread({ id: 'project', title: 'Project Thread', projectPath: '/proj/a', lastActiveAt: NOW - 2_000 }),
        makeThread({
          id: 'favorite',
          title: 'Favorite Thread',
          favorited: true,
          projectPath: '/proj/a',
          lastActiveAt: NOW - 3_000,
        }),
        makeThread({ id: 'system', title: 'System Thread', systemKind: 'eval_domain', lastActiveAt: NOW - 4_000 }),
      ],
      currentThreadId: 'recent',
      threadStates: {},
      isLoadingThreads: false,
    });
    const labels = [{ id: 'lbl-a', name: '开源', color: '#5B8C5A', sortOrder: 0, createdBy: 'u1', createdAt: 1 }];
    useLabelStore.setState({ labels, isLoading: false });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk(labels);
      return defaultSidebarApiMock(path);
    });
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });

  it('keeps lobby above the tab row and renders tabs in the v9 order', async () => {
    await harness.render();

    const lobby = harness.container.querySelector('[data-thread-id="default"]');
    expect(lobby).toBeNull();

    const tabsRow = harness.container.querySelector('[data-testid="sidebar-tabs-row"]');
    expect(tabsRow).not.toBeNull();

    const tabs = Array.from(harness.container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual(['置顶', '最近', '项目', '系统', '收藏']);
  });

  it('keeps label filtering in the same row as sidebar tabs', async () => {
    mockStore.threads = [
      makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
      makeThread({ id: 'unlabeled', title: 'Unlabeled Thread', projectPath: '/proj/a', lastActiveAt: NOW - 1_000 }),
      makeThread({
        id: 'labeled',
        title: 'Labeled Thread',
        projectPath: '/proj/a',
        labels: ['lbl-a'],
        lastActiveAt: NOW - 2_000,
      }),
    ];
    await harness.render();

    const tabsRow = harness.container.querySelector('[data-testid="sidebar-tabs-row"]');
    expect(tabsRow).not.toBeNull();
    if (!tabsRow) throw new Error('sidebar tabs row not found');
    expect(tabsRow?.textContent).toContain('标签');
    expect(harness.container.querySelector('[data-testid="sidebar-label-filter-bar"]')).toBeNull();

    const trigger = tabsRow.querySelector('[data-testid="sidebar-label-filter-trigger"]') as HTMLButtonElement | null;
    expect(trigger).toBeTruthy();
    if (!trigger) throw new Error('label filter trigger not found');
    await act(async () => {
      trigger.click();
    });
    await harness.flush();

    const filterButton = Array.from(
      harness.container.querySelectorAll('[data-testid="sidebar-label-filter-menu"] button'),
    ).find((button): button is HTMLButtonElement => button.textContent?.includes('未分类') ?? false);
    expect(filterButton).toBeTruthy();
    if (!filterButton) throw new Error('uncategorized filter button not found');
    expect(filterButton.textContent).toContain('未分类 (1)');

    await act(async () => {
      filterButton.click();
    });
    await harness.flush();

    expect(visibleThreadIds(harness.container)).toEqual(['unlabeled']);
  });

  it('switches isolated tab content without mixing system/project/favorite views', async () => {
    await harness.render();

    expect(visibleThreadIds(harness.container)).toEqual(['recent', 'project', 'favorite']);

    await clickTab(harness.container, 'system', harness.flush);
    // default (大厅) is a system thread — it appears alongside explicit system threads
    expect(visibleThreadIds(harness.container)).toEqual(['default', 'system']);

    await clickTab(harness.container, 'favorites', harness.flush);
    expect(visibleThreadIds(harness.container)).toEqual(['favorite']);
  });

  it('shows pinned threads in an isolated pinned tab while recent stays additive', async () => {
    Object.assign(mockStore, {
      threads: [
        makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
        makeThread({
          id: 'pinned-a',
          title: 'Pinned A',
          pinned: true,
          projectPath: '/proj/a',
          lastActiveAt: NOW - 1_000,
        }),
        makeThread({
          id: 'pinned-b',
          title: 'Pinned B',
          pinned: true,
          projectPath: '/proj/b',
          lastActiveAt: NOW - 2_000,
        }),
        makeThread({ id: 'regular', title: 'Regular', projectPath: '/proj/a', lastActiveAt: NOW - 3_000 }),
      ],
    });
    await harness.render();

    // Recent tab is additive — pinned threads still appear (sorted first by activity desc)
    expect(visibleThreadIds(harness.container)).toEqual(['pinned-a', 'pinned-b', 'regular']);

    // Pinned tab shows only pinned threads
    await clickTab(harness.container, 'pinned', harness.flush);
    expect(visibleThreadIds(harness.container)).toEqual(['pinned-a', 'pinned-b']);
  });

  it('lets the visible pin mark unpin the current thread without navigating', async () => {
    Object.assign(mockStore, {
      threads: [
        makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
        makeThread({
          id: 'pinned-a',
          title: 'Pinned A',
          pinned: true,
          projectPath: '/proj/a',
          lastActiveAt: NOW - 1_000,
        }),
      ],
      currentThreadId: 'pinned-a',
    });
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads/pinned-a' && init?.method === 'PATCH') {
        return jsonOk({ id: 'pinned-a', pinned: false });
      }
      if (path === '/api/labels') return jsonOk([]);
      return defaultSidebarApiMock(path);
    });
    await harness.render();

    const pinButton = harness.container.querySelector(
      '[data-testid="thread-pin-toggle-pinned-a"]',
    ) as HTMLButtonElement | null;
    expect(pinButton).toBeTruthy();
    if (!pinButton) throw new Error('pin toggle not found');

    await act(async () => {
      pinButton.click();
    });
    await harness.flush();

    expect(mockStore.updateThreadPin).toHaveBeenCalledWith('pinned-a', false);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows separate expand/collapse buttons in a project toolbar below the tabs', async () => {
    await harness.render();

    // Default (recent) tab is flat — no project toolbar.
    expect(harness.container.querySelector('[data-testid="project-toolbar"]')).toBeNull();

    // Project tab — toolbar appears inside the tab content, below the tabs row.
    await clickTab(harness.container, 'project', harness.flush);
    const tabsRow = harness.container.querySelector('[data-testid="sidebar-tabs-row"]');
    expect(tabsRow).not.toBeNull();

    const toolbar = harness.container.querySelector('[data-testid="project-toolbar"]');
    expect(toolbar).not.toBeNull();

    // Two separate buttons (not a single toggle): expand-all + collapse-all, both present.
    const expand = harness.container.querySelector('[data-testid="expand-all-btn"]');
    const collapse = harness.container.querySelector('[data-testid="collapse-all-btn"]');
    expect(expand).not.toBeNull();
    expect(collapse).not.toBeNull();
    // Both buttons live inside the toolbar (not the tabs row).
    expect(toolbar?.contains(expand)).toBe(true);
    expect(toolbar?.contains(collapse)).toBe(true);
    expect(tabsRow?.contains(expand)).toBe(false);
    // Icon-only (no text label).
    expect((expand as HTMLButtonElement)?.textContent?.trim()).toBe('');
    expect((collapse as HTMLButtonElement)?.textContent?.trim()).toBe('');
    expect((expand as HTMLButtonElement)?.getAttribute('aria-label')).toBe('展开全部项目');
    expect((collapse as HTMLButtonElement)?.getAttribute('aria-label')).toBe('折叠全部项目');

    const tabContent = harness.container.querySelector('[data-testid="sidebar-tab-content"]');
    expect(tabContent?.className).toContain('pt-1.5');
  });

  it('scrolls the active tab into view after selection', async () => {
    await harness.render();

    await clickTab(harness.container, 'favorites', harness.flush);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });
});
