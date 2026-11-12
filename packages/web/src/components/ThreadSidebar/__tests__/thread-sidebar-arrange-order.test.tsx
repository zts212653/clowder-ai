import type { ThreadAttentionMemberSort } from '@cat-cafe/shared';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLabelStore } from '@/stores/label-store';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { SIDEBAR_TAB_STORAGE_KEY } from '../sidebar-tab-state';
import type { ThreadAttentionGroupCommand } from '../use-attention-clusters';
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

describe('Issue #1964 production arrange interaction', () => {
  let harness: ThreadSidebarHarness;
  const memberIds = ['unpinned', 'old-pin', 'new-pin', 'tail-a', 'tail-b', 'tail-c'];
  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'recent');
    useLabelStore.setState({ labels: [], isLoading: false });
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
    harness = createThreadSidebarHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
    harness.cleanup();
    writeShellPresentation('classic');
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });

  async function setup(view: 'flat' | 'project' | 'virtual', mode?: ThreadAttentionMemberSort | 'recent') {
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, view === 'project' ? 'project' : 'recent');
    const threads = [
      ...memberIds,
      ...(view === 'virtual' ? Array.from({ length: 250 }, (_, i) => `extra-${i}`) : []),
    ].map((id, index) => ({
      id,
      title: id,
      projectPath: '/project',
      participants: [],
      createdBy: 'user',
      createdAt: 1,
      lastActiveAt: id === 'new-pin' ? 900 : 800 - index,
      pinned: id.endsWith('-pin'),
      presence: { status: 'idle' },
    }));
    Object.assign(mockStore, { threads, currentThreadId: 'old-pin', threadStates: {}, isLoadingThreads: false });
    let savedIds = [...memberIds];
    const preferences = () => ({
      aliases: {},
      open: { 'group:g': true },
      memberSort: mode && mode !== 'recent' ? { 'group:g': mode } : {},
      groups: [{ id: 'g', name: 'Fixture group', threadIds: savedIds }],
    });
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/config/thread-attention') return jsonOk(preferences());
      if (path === '/api/config/thread-attention/groups' && typeof init?.body === 'string') {
        const command = JSON.parse(init.body) as ThreadAttentionGroupCommand;
        if (command.action === 'move') {
          savedIds = savedIds.filter((id) => id !== command.threadId);
          const index = command.beforeThreadId ? savedIds.indexOf(command.beforeThreadId) : -1;
          savedIds.splice(index < 0 ? savedIds.length : index, 0, command.threadId);
        }
        return jsonOk(preferences());
      }
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await harness.flush();
    if (view === 'project') {
      await act(async () =>
        harness.container.querySelector<HTMLButtonElement>('[data-testid="expand-all-btn"]')?.click(),
      );
      await harness.flush();
    }
  }

  const order = () =>
    [...harness.container.querySelectorAll<HTMLElement>('[data-thread-id]')].map((el) => el.dataset.threadId);
  const remainder = () => harness.container.querySelector('[data-sidebar-row-key^="remainder:"]')?.textContent;
  async function enterArrange() {
    const source = harness.container.querySelector('[data-attention-draggable-thread="old-pin"]');
    expect(source).not.toBeNull();
    vi.useFakeTimers();
    await act(async () => {
      source?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      vi.advanceTimersByTime(450);
    });
    vi.useRealTimers();
    await harness.flush();
    expect(harness.container.querySelector('[data-testid="attention-arrange-toolbar"]')).not.toBeNull();
  }
  async function done() {
    await act(async () =>
      [...harness.container.querySelectorAll<HTMLButtonElement>('[data-testid="attention-arrange-toolbar"] button')]
        .find((button) => button.textContent === '完成')
        ?.click(),
    );
    await harness.flush();
  }

  async function drag(sourceId: string, targetId: string, after = false) {
    const source = harness.container.querySelector(`[data-attention-draggable-thread="${sourceId}"]`);
    await act(async () => source?.dispatchEvent(new MouseEvent('dragstart', { bubbles: true })));
    const target = harness.container.querySelector(
      targetId === 'header' ? '[data-attention-cluster="group:g"]' : `[data-attention-draggable-thread="${targetId}"]`,
    );
    await act(async () =>
      target?.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientY: after ? 1 : -1 })),
    );
    const line = target?.getAttribute('data-attention-insertion');
    await act(async () => target?.dispatchEvent(new MouseEvent('drop', { bubbles: true })));
    await harness.flush();
    return line;
  }

  it.each([
    ['recent', 'new-pin'],
    ['running-first', 'new-pin'],
    ['recent', 'header'],
    ['running-first', 'header'],
  ] as const)('does not reorder or write within %s on %s and hints at the source row', async (mode, targetId) => {
    await setup('flat', mode);
    await enterArrange();
    const before = order();
    expect(await drag('old-pin', targetId)).toBeNull();
    expect(order()).toEqual(before);
    expect(mockApiFetch.mock.calls.filter(([path]) => path.endsWith('/groups'))).toHaveLength(0);
    expect(
      harness.container.querySelector('[data-attention-draggable-thread="old-pin"] [role="status"]')?.textContent,
    ).toContain(mode === 'recent' ? '最近' : '运行');
    await done();
    expect(harness.container.querySelector('[data-attention-arrange-hint]')).toBeNull();
  });

  it('inserts manually after a row, saves beforeThreadId, and retains the pinned second row on remount', async () => {
    await setup('flat', 'manual');
    await enterArrange();
    expect(await drag('unpinned', 'old-pin', true)).toBe('after');
    expect(order().slice(0, 3)).toEqual(['old-pin', 'unpinned', 'new-pin']);
    const call = mockApiFetch.mock.calls.find(([path]) => path.endsWith('/groups'));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      action: 'move',
      groupId: 'g',
      threadId: 'unpinned',
      beforeThreadId: 'new-pin',
    });
    expect(await drag('new-pin', 'unpinned')).toBe('before');
    expect(order().slice(0, 3)).toEqual(['old-pin', 'new-pin', 'unpinned']);
    await done();
    harness.cleanup();
    harness = createThreadSidebarHarness();
    await harness.render();
    await harness.flush();
    expect(order().slice(0, 3)).toEqual(['old-pin', 'new-pin', 'unpinned']);
    expect(harness.container.querySelector('[aria-label="取消置顶 new-pin"]')).not.toBeNull();
  });

  it.each([
    'flat',
    'project',
    'virtual',
  ] as const)('keeps visible order, preview and pins through enter/Done in %s', async (view) => {
    await setup(view);
    const before = order();
    expect(before.slice(0, 4)).toEqual(['new-pin', 'old-pin', 'unpinned', 'tail-a']);
    const hidden = remainder();
    expect(hidden).toContain('2');
    await enterArrange();
    expect(order()).toEqual(before);
    expect(remainder()).toBe(hidden);
    expect(harness.container.querySelector('[aria-label="取消置顶 old-pin"]')).not.toBeNull();
    await done();
    expect(order()).toEqual(before);
    expect(remainder()).toBe(hidden);
    expect(
      mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PUT'),
    ).toHaveLength(0);
  });

  it('updates row facts while deferring new conversations and promotion until Done', async () => {
    await setup('flat');
    await enterArrange();
    const before = order();
    const store = useSidebarProjectionStore.getState();
    await act(async () =>
      store.applySidebarSnapshot(
        [
          ...store.rows.map((row) =>
            row.id === 'unpinned' ? { ...row, unreadCount: 7, presence: { status: 'working' as const } } : row,
          ),
          { ...store.rows[0]!, id: 'new-arrival', title: 'New arrival', pinned: true, lastActiveAt: 9999 },
        ],
        store.appliedGeneration + 1,
      ),
    );
    expect(order()).toEqual(before);
    expect(harness.container.querySelector('[data-thread-id="unpinned"]')?.textContent).toContain('7');
    expect(harness.container.querySelector('[data-thread-id="new-arrival"]')).toBeNull();
    await done();
    expect(order()).toContain('new-arrival');
  });

  it('keeps an explicitly revealed remainder visible after Done', async () => {
    await setup('flat');
    await enterArrange();
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-sidebar-row-key="remainder:group:g"] button')?.click(),
    );
    await harness.flush();
    expect(order()).toHaveLength(6);
    await done();
    expect(order()).toHaveLength(6);
  });

  it('allows cancelling a pin during arrange without moving the row', async () => {
    await setup('flat', 'manual');
    await enterArrange();
    const before = order();
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[aria-label="取消置顶 old-pin"]')?.click(),
    );
    await harness.flush();
    expect(
      mockApiFetch.mock.calls.some(([path, init]) => path === '/api/threads/old-pin' && init?.method === 'PATCH'),
    ).toBe(true);
    expect(order()).toEqual(before);
  });
});
