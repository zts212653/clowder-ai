import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLabelStore } from '@/stores/label-store';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { syncDraftToStorage } from '../../thread-drafts';
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

const { decisions } = vi.hoisted(() => ({ decisions: { status: 'ready', threadIds: new Set<string>() } }));
vi.mock('../use-group-decisions', () => ({ useGroupDecisions: () => decisions }));

describe('Issue #1964 arrange group geometry', () => {
  let harness: ThreadSidebarHarness;
  let open = false;
  let memberIds = ['member-a', 'member-b'];
  beforeEach(async () => {
    installThreadSidebarGlobals();
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    resetThreadSidebarMocks();
    decisions.threadIds = new Set();
    open = false;
    memberIds = ['member-a', 'member-b'];
    writeShellPresentation('v2');
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'recent');
    useLabelStore.setState({ labels: [], isLoading: false });
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
    const threads = ['member-a', 'member-b', 'outside'].map((id, index) => ({
      id,
      title: id,
      projectPath: '/A',
      participants: [],
      createdBy: 'user',
      createdAt: 1,
      lastActiveAt: 900 - index,
      pinned: id !== 'outside',
      presence: { status: 'idle' },
    }));
    Object.assign(mockStore, { threads, currentThreadId: 'outside', threadStates: {}, isLoadingThreads: false });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/config/thread-attention')
        return jsonOk({
          aliases: {},
          open: { 'group:g': open },
          groups: [{ id: 'g', name: 'Stable group', threadIds: memberIds }],
        });
      return defaultSidebarApiMock(path);
    });
    harness = createThreadSidebarHarness();
  });
  afterEach(() => {
    vi.useRealTimers();
    harness.cleanup();
    syncDraftToStorage('outside', undefined);
    writeShellPresentation('classic');
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function enter() {
    vi.useFakeTimers();
    await act(async () => {
      harness.container
        .querySelector('[data-attention-draggable-thread="outside"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      vi.advanceTimersByTime(450);
    });
    vi.useRealTimers();
    await harness.flush();
    expect(harness.container.querySelector('[data-testid="attention-arrange-toolbar"]')).not.toBeNull();
  }
  function slots() {
    const header = harness.container.querySelector('[data-attention-cluster="group:g"]');
    return {
      presence: Boolean(header?.querySelector('[data-testid="group-status-line"]')),
      peekIds: [...(header?.querySelectorAll<HTMLElement>('[data-thread-id]') ?? [])].map(
        (row) => row.dataset.threadId,
      ),
    };
  }
  const kinds = ['unread', 'mention', 'decision', 'working', 'done', 'error'] as const;
  async function facts(kind: (typeof kinds)[number], on: boolean, id = 'member-a') {
    decisions.threadIds = new Set(kind === 'decision' && on ? [id] : []);
    const store = useSidebarProjectionStore.getState();
    await act(async () =>
      store.applySidebarSnapshot(
        store.rows.map((row) =>
          row.id === id
            ? {
                ...row,
                unreadCount: kind === 'unread' && on ? 7 : 0,
                hasUserMention: kind === 'mention' && on,
                presence: { status: on && (kind === 'working' || kind === 'done' || kind === 'error') ? kind : 'idle' },
              }
            : row,
        ),
        store.appliedGeneration + 1,
      ),
    );
    await harness.flush();
  }
  it.each(
    kinds.flatMap((kind) => [false, true].map((initial) => ({ kind, initial }))),
  )('keeps collapsed slots when $kind changes from $initial', async ({ kind, initial }) => {
    await harness.render();
    await harness.flush();
    await facts(kind, initial);
    const before = slots();
    await enter();
    expect(slots()).toEqual(before);
    await facts(kind, !initial);
    expect(slots()).toEqual(before);
    const header = harness.container.querySelector('[data-attention-cluster="group:g"]');
    if (kind === 'unread' || kind === 'mention' || kind === 'decision') {
      expect(Boolean(header?.querySelector('[data-testid="group-count"]'))).toBe(!initial);
      if (initial) expect(header?.querySelector('[data-testid="group-peek-label"]')).toBeNull();
    } else {
      const selector =
        kind === 'working' ? 'group-running-cat' : kind === 'done' ? 'group-replied-cat' : 'group-error-dot';
      expect(
        Boolean(
          header?.querySelector(
            `[data-testid="${selector}"], [data-testid="arrange-signal-badge"][data-presence="${kind}"]`,
          ),
        ),
      ).toBe(!initial);
    }
    await act(async () =>
      [...harness.container.querySelectorAll<HTMLButtonElement>('[data-testid="attention-arrange-toolbar"] button')]
        .find((button) => button.textContent === '完成')
        ?.click(),
    );
    await harness.flush();
    if (kind === 'unread' || kind === 'mention' || kind === 'decision')
      expect(slots().peekIds).toEqual(initial ? [] : ['member-a']);
    else expect(slots().presence).toBe(!initial);
  });
  it.each(
    ['outside', 'member-a'].flatMap((id) =>
      kinds.flatMap((kind) => [false, true].map((initial) => ({ id, kind, initial }))),
    ),
  )('keeps $id signal slot for $kind from $initial', async ({ id, kind, initial }) => {
    open = id === 'member-a';
    await harness.render();
    await harness.flush();
    await facts(kind, initial, id);
    const row = () => harness.container.querySelector(`[data-attention-draggable-thread="${id}"]`);
    const signalSlot = () => Boolean(row()?.querySelector('[data-testid="thread-row-signals"]'));
    expect(signalSlot()).toBe(initial);
    await enter();
    await facts(kind, !initial, id);
    expect(signalSlot()).toBe(initial);
    const liveMarker = row()?.querySelector('[data-testid="arrange-signal-badge"]');
    if (!initial) expect(liveMarker).not.toBeNull();
  });
  it.each(
    kinds.flatMap((kind) => [false, true].map((initial) => ({ kind, initial }))),
  )('captures newly created group slots for $kind from $initial', async ({ kind, initial }) => {
    let created = false;
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path.endsWith('/groups')) created = true;
      if (path.startsWith('/api/config/thread-attention'))
        return jsonOk({
          aliases: {},
          open: { 'group:g': false },
          groups: created ? [{ id: 'g', threadIds: ['member-a', 'outside'] }] : [],
        });
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await enter();
    // Capture facts at the explicit grouping action, rather than at arrange entry.
    await facts(kind, initial);
    const source = harness.container.querySelector('[data-attention-draggable-thread="outside"]');
    const target = harness.container.querySelector('[data-attention-draggable-thread="member-a"]');
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();
    await act(async () => source?.dispatchEvent(new MouseEvent('dragstart', { bubbles: true })));
    await act(async () => target?.dispatchEvent(new MouseEvent('dragover', { bubbles: true })));
    await act(async () => target?.dispatchEvent(new MouseEvent('drop', { bubbles: true })));
    await harness.flush();
    const header = harness.container.querySelector('[data-attention-cluster="group:g"]');
    expect(header?.getAttribute('data-expanded')).toBe('true');
    await act(async () => header?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.click());
    await harness.flush();
    expect(header?.getAttribute('data-expanded')).toBe('false');
    const before = slots();
    await facts(kind, !initial);
    expect(slots()).toEqual(before);
    if (kind === 'unread' || kind === 'mention' || kind === 'decision')
      expect(Boolean(header?.querySelector('[data-testid="group-count"]'))).toBe(!initial);
    await act(async () =>
      [...harness.container.querySelectorAll<HTMLButtonElement>('[data-testid="attention-arrange-toolbar"] button')]
        .find((button) => button.textContent === '完成')
        ?.click(),
    );
    await harness.flush();
    if (kind === 'unread' || kind === 'mention' || kind === 'decision')
      expect(slots().peekIds).toEqual(initial ? [] : ['member-a']);
    else expect(slots().presence).toBe(!initial);
  });
  it('keeps captured peek identities and the more slot while live attention clears or moves to a hidden member', async () => {
    memberIds = ['member-a', 'member-b', 'member-c', 'member-d'];
    mockStore.threads = [
      ...(mockStore.threads as { id: string }[]),
      ...['member-c', 'member-d'].map((id) => ({
        id,
        title: id,
        projectPath: '/A',
        participants: [],
        createdBy: 'user',
        createdAt: 1,
        lastActiveAt: 800,
        pinned: true,
        presence: { status: 'idle' },
      })),
    ];
    await harness.render();
    const update = async (ids: string[]) => {
      const store = useSidebarProjectionStore.getState();
      await act(async () =>
        store.applySidebarSnapshot(
          store.rows.map((row) => ({ ...row, unreadCount: ids.includes(row.id) ? 1 : 0 })),
          store.appliedGeneration + 1,
        ),
      );
      await harness.flush();
    };
    await update(memberIds);
    expect(slots().peekIds).toEqual(['member-a', 'member-b', 'member-c']);
    await enter();
    await update(['member-b', 'member-c', 'member-d']);
    expect(slots().peekIds).toEqual(['member-a', 'member-b', 'member-c']);
    const read = harness.container.querySelector('[data-thread-id="member-a"]');
    expect(read?.querySelector('[data-testid="group-peek-label"]')).toBeNull();
    expect(harness.container.querySelector('[data-testid="group-peek-more"]')?.textContent).toContain('1');
    await update([]);
    expect(slots().peekIds).toHaveLength(3);
    expect(harness.container.querySelector('[data-testid="group-peek-more"]')).toBeNull();
    expect(harness.container.querySelector('[data-testid="group-peek-more-slot"]')).not.toBeNull();
  });
  it('keeps a measured split slot, clears old markers, and shows new draft facts without growing the slot', async () => {
    await harness.render();
    await facts('unread', true, 'outside');
    const line = harness.container.querySelector<HTMLElement>(
      '[data-attention-draggable-thread="outside"] [data-testid="thread-row-signals"]',
    );
    expect(line).not.toBeNull();
    if (!line) return;
    line.dataset.signalSplit = 'true';
    vi.spyOn(line, 'getBoundingClientRect').mockReturnValue({ height: 44 } as DOMRect);
    await enter();
    await facts('unread', false, 'outside');
    expect(line.style.height).toBe('44px');
    expect(line.dataset.signalSplit).toBe('true');
    await act(async () => syncDraftToStorage('outside', 'isolated draft'));
    expect(line.style.height).toBe('44px');
    expect(
      harness.container.querySelector('[data-testid="arrange-signal-badge"]')?.getAttribute('aria-label'),
    ).toContain('草稿');
    expect(line.querySelector('[data-testid="thread-row-draft"]')).toBeNull();
  });
});
