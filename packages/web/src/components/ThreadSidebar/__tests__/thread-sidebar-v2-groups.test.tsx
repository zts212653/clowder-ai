import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLabelStore } from '@/stores/label-store';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { SIDEBAR_TAB_STORAGE_KEY } from '../sidebar-tab-state';
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

vi.mock('../ThreadSidebarV2Header', () => ({ ThreadSidebarV2Header: () => null }));

describe('F322 production group preview and compact virtual navigation', () => {
  let harness: ThreadSidebarHarness;
  function setup(count = 11, current = 0) {
    const threads = Array.from({ length: count }, (_, index) => ({
      id: `member-${index}`,
      title: `Member ${index}`,
      projectPath: '/project',
      participants: [],
      createdBy: 'user',
      createdAt: 1710000000000,
      lastActiveAt: 1710000000000 - index,
      pinned: true,
      presence: { status: 'idle' },
    }));
    Object.assign(mockStore, {
      threads,
      currentThreadId: `member-${current}`,
      threadStates: {},
      isLoadingThreads: false,
    });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/config/thread-attention')
        return jsonOk({
          aliases: {},
          open: {},
          groups: [{ id: 'g', name: 'Our group', threadIds: threads.map((thread) => thread.id) }],
        });
      return defaultSidebarApiMock(path);
    });
  }
  async function locateCurrentConversation() {
    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>('[data-testid="select-open-session-btn"]')?.click();
    });
    for (let frame = 0; frame < 4; frame++)
      await act(async () => {
        await new Promise(requestAnimationFrame);
      });
  }
  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'pinned');
    useLabelStore.setState({ labels: [], isLoading: false });
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
    setup();
    harness = createThreadSidebarHarness();
  });
  afterEach(() => {
    harness.cleanup();
    writeShellLanguage('zh');
    writeShellPresentation('classic');
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });
  it('localizes production list controls, counts and trash while classic keeps its original copy', async () => {
    setup(1);
    act(() => writeShellLanguage('en'));
    await harness.render();
    expect(harness.container.querySelector('[data-testid="flat-toolbar"]')?.textContent).toContain('1 conversation');
    expect(harness.container.querySelector('[data-testid="select-open-session-btn"]')?.getAttribute('aria-label')).toBe(
      'Locate current conversation',
    );
    expect(harness.container.querySelector('[data-testid="trash-bin-toggle"]')?.textContent).toBe('Trash');
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="trash-bin-toggle"]')?.click(),
    );
    expect(harness.container.textContent).toContain('Trash is empty');
    act(() => writeShellPresentation('classic'));
    expect(harness.container.querySelector('[data-testid="flat-toolbar"]')?.textContent).toContain('1 个对话');
    expect(harness.container.querySelector('[data-testid="select-open-session-btn"]')?.getAttribute('aria-label')).toBe(
      '定位当前对话',
    );
    expect(harness.container.querySelector('[data-testid="trash-bin-toggle"]')?.textContent).toBe('回收站');
    expect(harness.container.textContent).toContain('回收站是空的');
  });
  it('renders four rows and expands the actual seven remaining conversations without selection or membership writes', async () => {
    await harness.render();
    expect(harness.container.querySelectorAll('[data-attention-cluster-member] [data-thread-id]')).toHaveLength(4);
    const segments = () =>
      [...harness.container.querySelectorAll('[data-sidebar-group-segment]')].map((element) =>
        element.getAttribute('data-sidebar-group-segment'),
      );
    expect(segments()).toEqual(['start', 'middle', 'middle', 'middle', 'middle', 'end']);
    expect(harness.container.querySelector('[data-cluster-rail]')).toBeNull();
    const remaining = [...harness.container.querySelectorAll('button')].find(
      (button) => button.textContent === '其余 7 个对话',
    );
    expect(remaining).toBeDefined();
    await act(async () => {
      remaining?.click();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(
      [...harness.container.querySelectorAll<HTMLElement>('[data-attention-cluster-member] [data-thread-id]')].map(
        (el) => el.dataset.threadId,
      ),
    ).toEqual(Array.from({ length: 11 }, (_, i) => `member-${i}`));
    expect(segments()).toEqual(['start', ...Array.from({ length: 10 }, () => 'middle'), 'end']);
    expect(document.activeElement?.textContent).toBe('Member 4');
    expect(mockStore.currentThreadId).toBe('member-0');
    expect(
      mockApiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT'),
    ).toHaveLength(0);
  });
  it('opens the only unread shortcut without expanding the collapsed Group, then withdraws its read signal', async () => {
    setup(6);
    const threads = mockStore.threads as { id: string; unreadCount?: number; hasUserMention?: boolean }[];
    threads[2].unreadCount = 2;
    threads[2].hasUserMention = true;
    const original = mockApiFetch.getMockImplementation();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/config/thread-attention')
        return jsonOk({
          aliases: {},
          open: { 'group:g': false },
          groups: [{ id: 'g', name: 'Our group', threadIds: threads.map((thread) => thread.id) }],
        });
      if (path === '/api/session') return jsonOk({ userId: 'owner' });
      if (path.startsWith('/api/concierge/work/decisions'))
        return jsonOk({
          version: 1,
          status: 'available',
          scope: 'owner_all_projects',
          identity: { ownerUserId: 'owner' },
          observedAt: 3,
          sources: {
            approvals: { status: 'available', exhaustiveness: 'complete' },
            needsMe: { status: 'available', exhaustiveness: 'complete' },
            personalPreferences: { status: 'available', exhaustiveness: 'complete' },
          },
          personalView: {
            mode: 'visible',
            preferenceRevision: 1,
            originalTotalCount: 0,
            visibleTotalCount: 0,
            ignoredTotalCount: 0,
            originalAttentionCount: 0,
            visibleAttentionCount: 0,
            ignoredAttentionCount: 0,
          },
          readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
          consistency: { state: 'verified', reasons: [] },
          items: [],
          totalCount: 0,
          page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
        });
      return original?.(path);
    });
    await harness.render();
    const header = () => harness.container.querySelector('[data-testid="group-header-v2"]');
    const peek = harness.container.querySelector<HTMLButtonElement>(
      '[data-peek-reason="mention"][data-thread-id="member-2"]',
    );
    expect(peek).not.toBeNull();
    expect(header()?.getAttribute('data-expanded')).toBe('false');
    expect(header()?.textContent).toContain('1 条要看');
    await act(async () => peek?.click());
    expect(harness.container.querySelector('[data-peek-reason]')).toBeNull();
    expect(header()?.getAttribute('data-expanded')).toBe('false');
    expect(header()?.querySelector('[data-testid="group-count"]')).toBeNull();
    expect(mockStore.clearUnread).toHaveBeenCalledWith('member-2');
    expect(window.location.pathname).toBe('/thread/member-2');
    expect(
      mockApiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT'),
    ).toHaveLength(0);
  });
  it('locates a current member beyond both the preview and the initial virtual window', async () => {
    setup(100, 90);
    await harness.render();
    expect(harness.container.querySelector('[data-testid="virtual-attention-list"]')).not.toBeNull();
    await locateCurrentConversation();
    expect(harness.container.querySelector('[data-thread-id="member-90"]')?.getAttribute('aria-current')).toBe('page');
    expect(harness.container.textContent).not.toContain('其余');
  });
  it('locates a member in the pointer-held reading order and again after leave releases recent sorting', async () => {
    setup(100, 90);
    await harness.render();
    act(() =>
      harness.container.querySelector('[data-testid="sidebar-thread-list"]')?.dispatchEvent(new Event('pointerenter')),
    );
    const projection = useSidebarProjectionStore.getState();
    await act(async () =>
      projection.applySidebarSnapshot(
        projection.rows.map((row) =>
          row.id === 'member-90' ? { ...row, lastActiveAt: row.lastActiveAt + 50_000 } : row,
        ),
        projection.appliedGeneration + 1,
      ),
    );
    expect(harness.container.querySelector('[data-thread-id="member-90"]')).toBeNull();
    await locateCurrentConversation();
    expect(harness.container.querySelector('[data-thread-id="member-90"]')?.getAttribute('aria-current')).toBe('page');
    act(() =>
      harness.container.querySelector('[data-testid="sidebar-thread-list"]')?.dispatchEvent(new Event('pointerleave')),
    );
    await locateCurrentConversation();
    expect(harness.container.querySelector('[data-thread-id="member-90"]')?.getAttribute('aria-current')).toBe('page');
  });
  it('keeps the production sort menu, rendered order and persisted reset aligned', async () => {
    setup(3);
    const threads = (mockStore.threads as { lastActiveAt: number }[]).map((thread, index) => ({
      ...thread,
      lastActiveAt: 1710000000000 + (index === 1 ? 50 : 0),
    }));
    mockStore.threads = threads;
    const preferences = {
      aliases: {},
      open: {},
      memberSort: {} as Record<string, string>,
      groups: [{ id: 'g', name: 'Our group', threadIds: ['member-0', 'member-1', 'member-2'] }],
    };
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path !== '/api/config/thread-attention') return defaultSidebarApiMock(path);
      if (init?.method === 'PUT') {
        const input = JSON.parse(String(init.body));
        if (input.memberSort === null) delete preferences.memberSort[input.anchor];
        else preferences.memberSort[input.anchor] = input.memberSort;
      }
      return jsonOk(preferences);
    });
    const order = () =>
      [...harness.container.querySelectorAll<HTMLElement>('[data-attention-cluster-member] [data-thread-id]')].map(
        (el) => el.dataset.threadId,
      );
    const click = async (text: string) =>
      act(async () => {
        const button = [...harness.container.querySelectorAll('button')].find(
          (el) => el.textContent === text || el.getAttribute('aria-label') === text,
        );
        expect(button, text).toBeDefined();
        button?.click();
      });
    await harness.render();
    expect(order()).toEqual(['member-1', 'member-0', 'member-2']);
    await click('更多操作');
    expect(harness.container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe(
      '最近活跃（默认）',
    );
    await click('手动顺序');
    expect(order()).toEqual(['member-0', 'member-1', 'member-2']);
    await click('更多操作');
    expect(harness.container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe(
      '手动顺序',
    );
    await click('最近活跃（默认）');
    expect(order()).toEqual(['member-1', 'member-0', 'member-2']);
    expect(preferences.memberSort).toEqual({});
    expect(
      mockApiFetch.mock.calls.some(([, init]) => String((init as RequestInit)?.body).includes('"memberSort":null')),
    ).toBe(true);
    await click('更多操作');
    expect(harness.container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe(
      '最近活跃（默认）',
    );
  });
});
