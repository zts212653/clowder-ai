import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/stores/chat-types';
import { useLabelStore } from '@/stores/label-store';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const NOW = 1710000000000;

type TestThread = Thread & Partial<Pick<SidebarSnapshotRow, 'presence' | 'unreadCount' | 'hasUserMention'>>;

function makeThread(overrides: Partial<TestThread> & { id: string }): TestThread {
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

async function enterSearch(container: HTMLElement, query: string, flush: () => Promise<void>) {
  const input = container.querySelector('input[placeholder="搜索对话、项目或 ID..."]') as HTMLInputElement | null;
  if (!input) throw new Error('sidebar search input not found');
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (valueDescriptor === undefined) throw new Error('HTMLInputElement value descriptor not found');
  const setInputValue = valueDescriptor.set;
  if (setInputValue === undefined) throw new Error('HTMLInputElement value setter not found');
  await act(async () => {
    setInputValue.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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

  it('keeps lobby in the system tab and renders tabs in the v9 order', async () => {
    await harness.render();

    const lobby = harness.container.querySelector('[data-thread-id="default"]');
    const tabsRow = harness.container.querySelector('[data-testid="sidebar-tabs-row"]');
    expect(lobby).toBeNull();
    expect(tabsRow).not.toBeNull();

    const tabs = Array.from(harness.container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual(['置顶', '最近', '项目', '系统', '收藏']);
  });

  it('virtualizes a large pinned list instead of mounting every thread item', async () => {
    const pinnedThreads = Array.from({ length: 250 }, (_, index) =>
      makeThread({
        id: `pinned-${index}`,
        title: `Pinned ${index}`,
        pinned: true,
        pinnedAt: NOW - index,
        lastActiveAt: NOW - index,
      }),
    );
    Object.assign(mockStore, {
      currentThreadId: 'pinned-0',
      threads: [makeThread({ id: 'default', title: '大厅' }), ...pinnedThreads],
    });

    await harness.render();

    const renderedIds = visibleThreadIds(harness.container);
    expect(renderedIds.length).toBeGreaterThan(0);
    expect(renderedIds.length).toBeLessThan(50);
    expect(renderedIds).toContain('pinned-0');
    expect(harness.container.querySelector('[data-testid="virtual-thread-list"]')).not.toBeNull();
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
    expect(tabsRow.textContent).toContain('标签');
    expect(harness.container.querySelector('[data-testid="sidebar-label-filter-bar"]')).toBeNull();

    const trigger = tabsRow.querySelector('[data-testid="sidebar-label-filter-trigger"]') as HTMLButtonElement | null;
    expect(trigger).toBeTruthy();
    if (!trigger) throw new Error('label filter trigger not found');
    await act(async () => trigger.click());
    await harness.flush();

    const filterButton = Array.from(
      harness.container.querySelectorAll('[data-testid="sidebar-label-filter-menu"] button'),
    ).find((button): button is HTMLButtonElement => button.textContent?.includes('未分类') ?? false);
    expect(filterButton).toBeTruthy();
    if (!filterButton) throw new Error('uncategorized filter button not found');
    expect(filterButton.textContent).toContain('未分类 (1)');

    await act(async () => filterButton.click());
    await harness.flush();
    expect(visibleThreadIds(harness.container)).toEqual(['unlabeled']);
  });

  it('switches isolated tab content without mixing system/project/favorite views', async () => {
    await harness.render();

    expect(visibleThreadIds(harness.container)).toEqual(['recent', 'project', 'favorite']);

    await clickTab(harness.container, 'system', harness.flush);
    expect(visibleThreadIds(harness.container)).toEqual(['default', 'system']);

    await clickTab(harness.container, 'favorites', harness.flush);
    expect(visibleThreadIds(harness.container)).toEqual(['favorite']);
  });

  it('renders canonical working rows above inactive unread rows without reshuffling concurrent work', async () => {
    Object.assign(mockStore, {
      currentThreadId: 'inactive-unread',
      threads: [
        makeThread({ id: 'default', title: '大厅' }),
        makeThread({
          id: 'working-first',
          title: 'Working First',
          pinned: true,
          lastActiveAt: NOW - 60_000,
          presence: { status: 'working', activeSince: NOW - 10 * 60_000 },
        }),
        makeThread({
          id: 'working-second',
          title: 'Working Second',
          pinned: true,
          lastActiveAt: NOW,
          presence: { status: 'working', activeSince: NOW - 5 * 60_000 },
        }),
        makeThread({
          id: 'inactive-unread',
          title: 'Inactive Unread',
          pinned: true,
          lastActiveAt: NOW + 1_000,
          unreadCount: 1,
          hasUserMention: false,
          presence: { status: 'idle' },
        }),
      ],
      threadStates: {},
    });

    await harness.render();
    await clickTab(harness.container, 'recent', harness.flush);

    expect(visibleThreadIds(harness.container)).toEqual(['working-first', 'working-second', 'inactive-unread']);
  });

  it('restores the user-selected tab after the sidebar remounts', async () => {
    Object.assign(mockStore, {
      currentThreadId: 'project',
      threads: [
        makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
        makeThread({ id: 'pinned', title: 'Pinned Thread', pinned: true, projectPath: '/proj/a' }),
        makeThread({ id: 'project', title: 'Project Thread', projectPath: '/proj/a' }),
      ],
    });

    await harness.render();
    await clickTab(harness.container, 'pinned', harness.flush);
    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );

    harness.cleanup();
    harness = createThreadSidebarHarness();
    await harness.render();

    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('switches to a non-empty tab when global search hits outside the active tab', async () => {
    await harness.render();

    await enterSearch(harness.container, 'System Thread', harness.flush);

    expect(harness.container.querySelector('[data-testid="sidebar-tab-system"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(visibleThreadIds(harness.container)).toEqual(['system']);
    expect(harness.container.textContent).not.toContain('没有匹配的对话');
  });

  it('restores the user-selected tab after clearing a global search', async () => {
    await harness.render();
    await clickTab(harness.container, 'favorites', harness.flush);

    await enterSearch(harness.container, 'System Thread', harness.flush);
    expect(harness.container.querySelector('[data-testid="sidebar-tab-system"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );

    await enterSearch(harness.container, '', harness.flush);

    expect(
      harness.container.querySelector('[data-testid="sidebar-tab-favorites"]')?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('keeps a later user tab selection when the same search gets asynchronous results', async () => {
    await harness.render();
    await enterSearch(harness.container, 'Late System Result', harness.flush);
    expect(harness.container.textContent).toContain('没有匹配的对话');

    await clickTab(harness.container, 'pinned', harness.flush);
    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );

    mockStore.threads = [
      ...(mockStore.threads as Thread[]),
      makeThread({
        id: 'late-system-result',
        title: 'Late System Result',
        systemKind: 'eval_domain',
        lastActiveAt: NOW + 1_000,
      }),
    ];
    await harness.render();

    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('opens the system tab when the active thread is an unpinned system thread', async () => {
    Object.assign(mockStore, { currentThreadId: 'system' });

    await harness.render();

    expect(harness.container.querySelector('[data-testid="sidebar-tab-system"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(visibleThreadIds(harness.container)).toEqual(['default', 'system']);
  });

  it('opens the recent tab when the active regular thread is beyond the old 8-item limit (clowder-ai#1305)', async () => {
    Object.assign(mockStore, {
      currentThreadId: 'regular-9',
      threads: [
        makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
        ...Array.from({ length: 10 }, (_, index) =>
          makeThread({
            id: `regular-${index}`,
            title: `Regular ${index}`,
            projectPath: `/proj/${index}`,
            lastActiveAt: NOW - index * 1_000,
          }),
        ),
      ],
    });

    await harness.render();

    expect(harness.container.querySelector('[data-testid="sidebar-tab-recent"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(visibleThreadIds(harness.container)).toContain('regular-9');
  });

  it('waits for route and store convergence before resolving the initial natural tab', async () => {
    const threads = [
      makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
      ...Array.from({ length: 10 }, (_, index) =>
        makeThread({
          id: `regular-${index}`,
          title: `Regular ${index}`,
          projectPath: `/proj/${index}`,
          lastActiveAt: NOW - index * 1_000,
        }),
      ),
    ];
    Object.assign(mockStore, { currentThreadId: 'default', threads });

    await harness.render({ routeThreadId: 'regular-9' });
    expect(harness.container.querySelector('[data-testid="sidebar-tab-recent"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );

    Object.assign(mockStore, { currentThreadId: 'regular-9' });
    await harness.render({ routeThreadId: 'regular-9' });

    expect(harness.container.querySelector('[data-testid="sidebar-tab-recent"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(visibleThreadIds(harness.container)).toContain('regular-9');
  });

  it('keeps the user-selected pinned tab when an external link navigates to a project thread', async () => {
    const recentThreads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: `recent-${index}`,
        title: `Recent ${index}`,
        projectPath: `/proj/${index}`,
        lastActiveAt: NOW - index * 1_000,
      }),
    );
    Object.assign(mockStore, {
      currentThreadId: 'pinned',
      threads: [
        makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
        makeThread({
          id: 'pinned',
          title: 'Pinned Thread',
          pinned: true,
          projectPath: '/proj/pinned',
          lastActiveAt: NOW - 9_000,
        }),
        ...recentThreads,
        makeThread({
          id: 'linked-project-thread',
          title: 'Linked Project Thread',
          projectPath: '/proj/linked',
          lastActiveAt: NOW - 10_000,
        }),
      ],
    });

    await harness.render();
    await clickTab(harness.container, 'pinned', harness.flush);

    Object.assign(mockStore, { currentThreadId: 'linked-project-thread' });
    await harness.render();

    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('stays on the current tab when recent membership changes (no auto-jump)', async () => {
    const regularThreads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: `regular-${index}`,
        title: `Regular ${index}`,
        projectPath: `/proj/${index}`,
        lastActiveAt: NOW - index * 1_000,
      }),
    );
    Object.assign(mockStore, {
      currentThreadId: 'regular-7',
      threads: [makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }), ...regularThreads],
    });

    await harness.render();

    expect(harness.container.querySelector('[data-testid="sidebar-tab-recent"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(visibleThreadIds(harness.container)).toContain('regular-7');

    Object.assign(mockStore, {
      threads: [
        makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
        makeThread({
          id: 'newest',
          title: 'Newest Thread',
          projectPath: '/proj/newest',
          lastActiveAt: NOW + 1_000,
        }),
        ...regularThreads,
      ],
    });

    await harness.render();

    // Tab should NOT auto-jump when thread list changes but the current
    // thread hasn't changed — the user's explicit tab choice is preserved.
    expect(harness.container.querySelector('[data-testid="sidebar-tab-recent"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
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

  it('renders archived projects as nested project groups inside the archive container', async () => {
    Object.assign(mockStore, {
      currentThreadId: 'old-a-thread',
      threads: [
        makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
        makeThread({
          id: 'active-thread',
          title: 'Active Thread',
          projectPath: '/proj/active',
          lastActiveAt: Date.now(),
        }),
        makeThread({
          id: 'old-a-thread',
          title: 'Old A Thread',
          projectPath: '/proj/old-a',
          lastActiveAt: NOW - 30 * 24 * 60 * 60 * 1_000,
        }),
        makeThread({
          id: 'old-b-thread',
          title: 'Old B Thread',
          projectPath: '/proj/old-b',
          lastActiveAt: NOW - 31 * 24 * 60 * 60 * 1_000,
        }),
      ],
    });

    await harness.render();
    await clickTab(harness.container, 'project', harness.flush);

    expect(harness.container.textContent).toContain('其他项目 (2)');
    expect(harness.container.textContent).toContain('old-a');
    expect(harness.container.textContent).toContain('old-b');
    expect(visibleThreadIds(harness.container)).toContain('old-a-thread');
  });

  it('scrolls the active tab into view after selection', async () => {
    await harness.render();

    await clickTab(harness.container, 'favorites', harness.flush);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });

  it('stays on pinned when unpinning the current thread from the pinned tab', async () => {
    const pinnedA = makeThread({
      id: 'pinned-a',
      title: 'Pinned A',
      pinned: true,
      projectPath: '/proj/a',
      lastActiveAt: NOW - 1_000,
    });
    const pinnedB = makeThread({
      id: 'pinned-b',
      title: 'Pinned B',
      pinned: true,
      projectPath: '/proj/b',
      lastActiveAt: NOW - 2_000,
    });
    const otherThreads = [
      makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
      makeThread({ id: 'regular', title: 'Regular', projectPath: '/proj/a', lastActiveAt: NOW - 3_000 }),
    ];
    Object.assign(mockStore, {
      currentThreadId: 'pinned-a',
      threads: [otherThreads[0], pinnedA, pinnedB, otherThreads[1]],
    });

    // Mock the PATCH — create new thread object + array so React detects the change
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (typeof path === 'string' && path.startsWith('/api/threads/') && init?.method === 'PATCH') {
        const unpinned = { ...pinnedA, pinned: false };
        mockStore.threads = [otherThreads[0], unpinned, pinnedB, otherThreads[1]];
        return jsonOk({ pinned: false });
      }
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    // Navigate to the pinned tab
    await clickTab(harness.container, 'pinned', harness.flush);
    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );

    // Click the fixed "取消置顶" pin button on pinned-a
    const threadItem = harness.container.querySelector('[data-thread-id="pinned-a"]') as HTMLElement;
    expect(threadItem).not.toBeNull();
    const unpinButton = threadItem.querySelector('button[title="取消置顶"]') as HTMLButtonElement;
    expect(unpinButton).not.toBeNull();
    await act(async () => {
      unpinButton.click();
    });
    await harness.flush();

    // Re-render to pick up the store mutation (new array reference)
    await harness.render();

    // Tab should stay on 'pinned' — the user explicitly chose the pinned
    // tab and unpinning is a property change, not a navigation. The sidebar
    // should NOT auto-jump to a different tab.
    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('stays on pinned when a filtered current thread loses pinned membership', async () => {
    const pinned = makeThread({
      id: 'filtered-pinned',
      title: 'Filtered Pinned Thread',
      pinned: true,
      projectPath: '/proj/a',
      lastActiveAt: NOW - 1_000,
    });
    const defaultThread = makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW });
    Object.assign(mockStore, {
      currentThreadId: pinned.id,
      threads: [defaultThread, pinned],
    });
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (typeof path === 'string' && path.startsWith('/api/threads/') && init?.method === 'PATCH') {
        mockStore.threads = [defaultThread, { ...pinned, pinned: false }];
        return jsonOk({ pinned: false });
      }
      return defaultSidebarApiMock(path);
    });

    await harness.render();
    await clickTab(harness.container, 'pinned', harness.flush);
    await enterSearch(harness.container, 'Filtered Pinned Thread', harness.flush);

    const threadItem = harness.container.querySelector('[data-thread-id="filtered-pinned"]') as HTMLElement;
    const unpinButton = threadItem.querySelector('button[title="取消置顶"]') as HTMLButtonElement;
    await act(async () => {
      unpinButton.click();
    });
    await harness.flush();
    await harness.render();

    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('stays on pinned tab when unpinning an old thread outside the recent limit', async () => {
    // Edge case: if the pinned thread is older than recentLimit, it disappears
    // from both pinned and recent after unpinning. The user's selected tab still wins.
    const oldPinned = makeThread({
      id: 'old-pinned',
      title: 'Old Pinned Thread',
      pinned: true,
      projectPath: '/proj/old',
      lastActiveAt: NOW - 100_000, // Much older than the 8 regular threads
    });
    const regularThreads = Array.from({ length: 8 }, (_, i) =>
      makeThread({
        id: `reg-${i}`,
        title: `Regular ${i}`,
        projectPath: '/proj/a',
        lastActiveAt: NOW - i * 1_000,
      }),
    );
    const defaultThread = makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW });
    Object.assign(mockStore, {
      currentThreadId: 'old-pinned',
      threads: [defaultThread, oldPinned, ...regularThreads],
    });

    // Make PATCH succeed — create new thread object + array so React detects the change
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (typeof path === 'string' && path.startsWith('/api/threads/') && init?.method === 'PATCH') {
        const unpinned = { ...oldPinned, pinned: false };
        mockStore.threads = [defaultThread, unpinned, ...regularThreads];
        return jsonOk({ pinned: false });
      }
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    // Navigate to pinned tab
    await clickTab(harness.container, 'pinned', harness.flush);
    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );

    // Click the fixed "取消置顶" pin button on old-pinned
    const threadItem = harness.container.querySelector('[data-thread-id="old-pinned"]') as HTMLElement;
    expect(threadItem).not.toBeNull();
    const unpinButton = threadItem.querySelector('button[title="取消置顶"]') as HTMLButtonElement;
    expect(unpinButton).not.toBeNull();
    await act(async () => {
      unpinButton.click();
    });
    await harness.flush();

    // Re-render to pick up the store mutation
    await harness.render();

    const activeTabId = Array.from(harness.container.querySelectorAll('[role="tab"]'))
      .find((tab) => tab.getAttribute('aria-selected') === 'true')
      ?.getAttribute('data-testid');
    // Tab should stay on 'pinned' — unpinning is a property change, not
    // navigation. The user chose the pinned tab explicitly.
    expect(activeTabId).toBe('sidebar-tab-pinned');
  });

  it('stays on pinned tab when unpinning a pinned system thread', async () => {
    // Even for system threads, unpinning should not auto-switch tabs.
    const sysThread = makeThread({
      id: 'sys-pinned',
      title: 'System Pinned',
      pinned: true,
      systemKind: 'eval_domain',
      lastActiveAt: NOW - 1_000,
    });
    const otherThreads = [
      makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
      makeThread({ id: 'regular', title: 'Regular', projectPath: '/proj/a', lastActiveAt: NOW - 2_000 }),
    ];
    Object.assign(mockStore, {
      currentThreadId: 'sys-pinned',
      threads: [otherThreads[0], sysThread, otherThreads[1]],
    });

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (typeof path === 'string' && path.startsWith('/api/threads/') && init?.method === 'PATCH') {
        // Create a NEW thread object + array so React detects the change
        const unpinned = { ...sysThread, pinned: false };
        mockStore.threads = [otherThreads[0], unpinned, otherThreads[1]];
        return jsonOk({ pinned: false });
      }
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    // Navigate to pinned tab
    await clickTab(harness.container, 'pinned', harness.flush);
    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );

    // Click the fixed "取消置顶" pin button on sys-pinned
    const threadItem = harness.container.querySelector('[data-thread-id="sys-pinned"]') as HTMLElement;
    expect(threadItem).not.toBeNull();
    const unpinButton = threadItem.querySelector('button[title="取消置顶"]') as HTMLButtonElement;
    expect(unpinButton).not.toBeNull();
    await act(async () => {
      unpinButton.click();
    });
    await harness.flush();

    // Re-render to pick up the store mutation (new array reference)
    await harness.render();

    const activeTabId = Array.from(harness.container.querySelectorAll('[role="tab"]'))
      .find((tab) => tab.getAttribute('aria-selected') === 'true')
      ?.getAttribute('data-testid');
    // Tab stays on 'pinned' — unpinning is a property change, not navigation
    expect(activeTabId).toBe('sidebar-tab-pinned');
  });

  it('stays on favorites tab when unfavoriting the current thread', async () => {
    const favThread = makeThread({
      id: 'fav-thread',
      title: 'Favorite Thread',
      favorited: true,
      projectPath: '/proj/a',
      lastActiveAt: NOW - 1_000,
    });
    const otherThreads = [
      makeThread({ id: 'default', title: '大厅', lastActiveAt: NOW }),
      makeThread({ id: 'regular', title: 'Regular', projectPath: '/proj/a', lastActiveAt: NOW - 2_000 }),
    ];
    Object.assign(mockStore, {
      currentThreadId: 'fav-thread',
      threads: [otherThreads[0], favThread, otherThreads[1]],
    });

    // Mock the PATCH — create new thread object + array so React detects the change
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (typeof path === 'string' && path.startsWith('/api/threads/') && init?.method === 'PATCH') {
        const unfavorited = { ...favThread, favorited: false };
        mockStore.threads = [otherThreads[0], unfavorited, otherThreads[1]];
        return jsonOk({ favorited: false });
      }
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    // Navigate to the favorites tab
    await clickTab(harness.container, 'favorites', harness.flush);
    expect(
      harness.container.querySelector('[data-testid="sidebar-tab-favorites"]')?.getAttribute('aria-selected'),
    ).toBe('true');

    // Open context menu and click "取消收藏"
    const threadItem = harness.container.querySelector('[data-thread-id="fav-thread"]') as HTMLElement;
    expect(threadItem).not.toBeNull();
    const moreButton = threadItem.querySelector('button[title="更多操作"]') as HTMLButtonElement;
    expect(moreButton).not.toBeNull();
    await act(async () => {
      moreButton.click();
    });
    await harness.flush();

    const unfavButton = Array.from(threadItem.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes('取消收藏'),
    ) as HTMLElement;
    expect(unfavButton).not.toBeNull();
    await act(async () => {
      unfavButton.click();
    });
    await harness.flush();

    // Re-render to pick up the store mutation (new array reference)
    await harness.render();

    // Tab should stay on 'favorites' — unfavoriting is a property change,
    // not navigation. The sidebar should NOT auto-jump.
    expect(
      harness.container.querySelector('[data-testid="sidebar-tab-favorites"]')?.getAttribute('aria-selected'),
    ).toBe('true');
  });
});
