import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLabelStore } from '@/stores/label-store';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { STORAGE_KEY } from '../collapse-state';
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

describe('Issue #1964 arrange entry coverage', () => {
  let harness: ThreadSidebarHarness;
  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    writeShellPresentation('v2');
    writeShellLanguage('zh');
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
  async function setup(
    tab: 'project' | 'favorites' | 'system' | 'pinned',
    archived = false,
    grouped: string[] = [],
    mode: 'recent' | 'manual' | 'running-first' = 'recent',
  ) {
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, tab);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['/B']));
    const threads = ['a1', 'a2', 'b1'].map((id, index) => ({
      id,
      title: id,
      projectPath: id === 'b1' ? '/B' : '/A',
      participants: [],
      createdBy: 'user',
      createdAt: Date.now(),
      lastActiveAt: archived ? 1 : Date.now() + index,
      favorited: tab === 'favorites',
      pinned: tab === 'pinned',
      systemKind: tab === 'system' ? 'eval_domain' : undefined,
      presence: { status: 'idle' },
    }));
    Object.assign(mockStore, { threads, currentThreadId: 'a1', threadStates: {}, isLoadingThreads: false });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/config/thread-attention')
        return jsonOk({
          groups: grouped.length ? [{ id: 'g', name: 'Group', threadIds: grouped }] : [],
          aliases: {},
          open: {},
          memberSort: mode === 'recent' ? {} : { 'group:g': mode },
        });
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await harness.flush();
  }
  function order(root: ParentNode = harness.container) {
    return [...root.querySelectorAll<HTMLElement>('[data-thread-id]')].map((row) => row.dataset.threadId);
  }
  async function enter() {
    vi.useFakeTimers();
    await act(async () =>
      harness.container
        .querySelector('[data-attention-draggable-thread="a1"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })),
    );
    await act(async () => vi.advanceTimersByTime(450));
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

  it.each([
    false,
    true,
  ])('reveals a collapsed project (archived=%s) during arrange and accepts a target', async (archived) => {
    await setup('project', archived);
    const before = order();
    expect([...before].sort()).toEqual(['a1', 'a2']);
    await enter();
    const store = useSidebarProjectionStore.getState();
    await act(async () =>
      store.applySidebarSnapshot(
        [...store.rows, { ...store.rows.find((row) => row.id === 'b1')!, id: 'new-b', title: 'New B conversation' }],
        store.appliedGeneration + 1,
      ),
    );
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-project-path="/B"]')?.click());
    await harness.flush();
    const b = harness.container.querySelector('[data-project-path="/B"]')?.closest('[class~="group/section"]');
    expect(b).not.toBeNull();
    expect(order(b!)).toEqual(['b1']);
    expect(order().filter((id) => id !== 'b1')).toEqual(before);
    const preferences = { groups: [{ id: 'g', name: 'New group', threadIds: ['a1', 'b1'] }], aliases: {}, open: {} };
    const normalApi = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) =>
      path.endsWith('/groups') ? jsonOk(preferences) : normalApi(path, init),
    );
    await act(async () =>
      harness.container
        .querySelector('[data-attention-draggable-thread="a1"]')
        ?.dispatchEvent(new MouseEvent('dragstart', { bubbles: true })),
    );
    await act(async () =>
      b
        ?.querySelector('[data-attention-draggable-thread="b1"]')
        ?.dispatchEvent(new MouseEvent('drop', { bubbles: true })),
    );
    await harness.flush();
    expect(mockApiFetch.mock.calls.some(([path]) => path.endsWith('/groups'))).toBe(true);
    expect(order(b!)).toEqual(['b1']);
    await done();
    expect(order()).toContain('new-b');
  });

  it.each([
    ['create', 200],
    ['move', 200],
    ['remove', 200],
    ['create', 409],
    ['move', 500],
  ] as const)('keeps favorite %s commands with status %s without Group presentation', async (action, status) => {
    await setup('favorites', false, action === 'create' ? [] : action === 'move' ? ['a2', 'b1'] : ['a1', 'a2', 'b1']);
    const before = order();
    await enter();
    const preferences = {
      groups: [{ id: 'g', name: 'Group', threadIds: action === 'remove' ? ['a2', 'b1'] : ['a1', 'a2', 'b1'] }],
      aliases: {},
      open: {},
    };
    const normalApi = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) =>
      path.endsWith('/groups')
        ? status === 200
          ? jsonOk(preferences)
          : Promise.resolve(new Response('{}', { status }))
        : normalApi(path, init),
    );
    await act(async () =>
      harness.container
        .querySelector('[data-attention-draggable-thread="a1"]')
        ?.dispatchEvent(new MouseEvent('dragstart', { bubbles: true })),
    );
    await act(async () =>
      harness.container
        .querySelector(action === 'remove' ? '[data-attention-remove-drop]' : '[data-attention-draggable-thread="a2"]')
        ?.dispatchEvent(new MouseEvent('drop', { bubbles: true })),
    );
    await harness.flush();
    const call = mockApiFetch.mock.calls.find(([path]) => path.endsWith('/groups'));
    expect(JSON.parse(String(call?.[1]?.body)).action).toBe(action);
    expect(harness.container.querySelector('[data-attention-cluster]')).toBeNull();
    expect(order()).toEqual(before);
    await done();
    expect(order()).toEqual(before);
  });

  it.each([
    'manual',
    'recent',
    'running-first',
  ] as const)('does not offer hidden %s reordering between favorite rows', async (mode) => {
    await setup('favorites', false, ['b1', 'a2', 'a1'], mode);
    const before = order();
    await enter();
    const source = harness.container.querySelector('[data-attention-draggable-thread="a1"]');
    const target = harness.container.querySelector('[data-attention-draggable-thread="a2"]');
    await act(async () => source?.dispatchEvent(new MouseEvent('dragstart', { bubbles: true })));
    await act(async () => target?.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientY: -1 })));
    const insertion = target?.getAttribute('data-attention-insertion');
    await act(async () => target?.dispatchEvent(new MouseEvent('drop', { bubbles: true })));
    await harness.flush();
    expect({ insertion, commands: mockApiFetch.mock.calls.filter(([path]) => path.endsWith('/groups')) }).toEqual({
      insertion: null,
      commands: [],
    });
    expect(harness.container.querySelector('[data-attention-cluster]')).toBeNull();
    expect(harness.container.querySelector('[data-attention-arrange-hint]')).toBeNull();
    expect(order()).toEqual(before);
    await done();
    expect(order()).toEqual(before);
  });

  it('keeps a newly unpinned row in the pinned view until Done', async () => {
    await setup('pinned');
    const before = order();
    await enter();
    const store = useSidebarProjectionStore.getState();
    await act(async () =>
      store.applySidebarSnapshot(
        store.rows.map((row) => (row.id === 'b1' ? { ...row, pinned: false } : row)),
        store.appliedGeneration + 1,
      ),
    );
    expect(order()).toEqual(before);
    await done();
    expect(order()).not.toContain('b1');
  });

  it('freezes virtual favorite rows and admits promotion only on Done', async () => {
    await setup('favorites');
    const store = useSidebarProjectionStore.getState();
    const extras = Array.from({ length: 60 }, (_, index) => ({
      ...store.rows[0]!,
      id: `extra-${index}`,
      title: `Z ${index}`,
    }));
    await act(async () => store.applySidebarSnapshot([...store.rows, ...extras], store.appliedGeneration + 1));
    expect(harness.container.querySelector('[data-testid="virtual-attention-list"]')).not.toBeNull();
    const before = order();
    await enter();
    const current = useSidebarProjectionStore.getState();
    await act(async () =>
      current.applySidebarSnapshot(
        current.rows.map((row) => (row.id === 'extra-59' ? { ...row, pinned: true } : row)),
        current.appliedGeneration + 1,
      ),
    );
    expect(order()).toEqual(before);
    await done();
    expect(order()[0]).toBe('extra-59');
  });

  it('keeps system conversations outside the existing arrange entry', async () => {
    await setup('system');
    vi.useFakeTimers();
    await act(async () =>
      harness.container
        .querySelector('[data-thread-id="a1"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })),
    );
    await act(async () => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    expect(harness.container.querySelector('[data-testid="attention-arrange-toolbar"]')).toBeNull();
  });

  it.each([
    'working',
    'pin',
  ] as const)('freezes favorite rows while %s facts update, then sorts on Done', async (change) => {
    await setup('favorites');
    const before = order();
    expect(before).toEqual(['a1', 'a2', 'b1']);
    await enter();
    const store = useSidebarProjectionStore.getState();
    await act(async () =>
      store.applySidebarSnapshot(
        store.rows.map((row) =>
          row.id === 'b1'
            ? {
                ...row,
                ...(change === 'pin' ? { pinned: true } : { unreadCount: 7, presence: { status: 'working' as const } }),
              }
            : row,
        ),
        store.appliedGeneration + 1,
      ),
    );
    expect(order()).toEqual(before);
    if (change === 'pin') expect(harness.container.querySelector('[aria-label="取消置顶 b1"]')).not.toBeNull();
    else expect(harness.container.querySelector('[data-thread-id="b1"]')?.textContent).toContain('7');
    await done();
    expect(order()[0]).toBe('b1');
  });
});
