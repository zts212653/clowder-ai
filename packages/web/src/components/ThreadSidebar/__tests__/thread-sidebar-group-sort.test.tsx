import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLabelStore } from '@/stores/label-store';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
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
  textFail,
} from './thread-sidebar-test-helpers';

const anchor = 'group:attention_sort';
const group = { id: 'attention_sort', name: '发布工作台', threadIds: ['a', 'b', 'c'] };

describe('Group member sorting and reading stability', () => {
  let harness: ThreadSidebarHarness;
  let open: Record<string, boolean>;
  let memberSort: Record<string, string>;
  let failSave: boolean;
  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    open = { [anchor]: true };
    memberSort = {};
    failSave = false;
    Object.assign(mockStore, {
      threads: ['a', 'b', 'c', 'other'].map((id) => ({
        id,
        title: `发布 ${id}`,
        projectPath: '/project',
        participants: [],
        createdBy: 'user',
        createdAt: Date.now(),
        lastActiveAt: Date.now() - (id === 'other' ? 0 : 60000),
        pinned: true,
        unreadCount: id === 'a' ? 2 : 0,
      })),
      currentThreadId: 'default',
      threadStates: {},
      isLoadingThreads: false,
    });
    useLabelStore.setState({ labels: [], isLoading: false });
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path !== '/api/config/thread-attention') return defaultSidebarApiMock(path);
      if (init?.method === 'PUT') {
        if (failSave) return textFail();
        const body = JSON.parse(String(init.body));
        if (body.open !== undefined) open = { ...open, [body.anchor]: body.open };
        if (body.memberSort !== undefined) memberSort = { ...memberSort, [body.anchor]: body.memberSort };
      }
      return jsonOk({ aliases: {}, open, memberSort, groups: [group] });
    });
    harness = createThreadSidebarHarness();
  });
  afterEach(() => {
    harness.cleanup();
    resetThreadSidebarGlobals();
  });

  const header = () => harness.container.querySelector<HTMLElement>(`[data-attention-cluster="${anchor}"]`);
  const ids = () =>
    [
      ...harness.container.querySelectorAll<HTMLElement>(
        `[data-attention-cluster-member="${anchor}"] [data-thread-id]`,
      ),
    ].map((el) => el.dataset.threadId);
  const allIds = () =>
    [...harness.container.querySelectorAll<HTMLElement>('[data-thread-id]')].map((el) => el.dataset.threadId);
  async function select(value: string) {
    const control = header()?.querySelector<HTMLSelectElement>('select[aria-label="发布工作台 组内排序"]');
    expect(control, 'Group offers an explicit persistent sorting choice').not.toBeNull();
    await act(async () => {
      if (control) {
        control.value = value;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await harness.flush();
  }
  async function toggle() {
    await act(async () => header()?.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click());
    await harness.flush();
  }
  async function presence(working: string, unread = 2) {
    const store = useSidebarProjectionStore.getState();
    await act(async () =>
      store.applySidebarSnapshot(
        store.rows.map((row) => ({
          ...row,
          unreadCount: row.id === 'a' ? unread : 0,
          presence: { status: row.id === working ? ('working' as const) : ('done' as const) },
        })),
        store.appliedGeneration + 1,
      ),
    );
  }

  it('keeps legacy manual order, then explicitly promotes running members without rewriting membership', async () => {
    await harness.render();
    await presence('c');
    expect(ids()).toEqual(['a', 'b', 'c']);
    await select('running-first');
    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(memberSort[anchor]).toBe('running-first');
    expect(group.threadIds).toEqual(['a', 'b', 'c']);
    expect(header()?.dataset.expanded).toBe('true');
    await select('manual');
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('freezes the open Group and its outer placement while updating live status, then sorts on reopen', async () => {
    await harness.render();
    await presence('c');
    await select('running-first');
    const before = allIds();
    await presence('b', 0);
    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(allIds()).toEqual(before);
    expect(header()?.textContent).toContain('进行中 1');
    expect(header()?.textContent).not.toContain('未读');
    await toggle();
    await toggle();
    expect(ids()).toEqual(['b', 'a', 'c']);
  });

  it('does not move an expanded manual Group when reading changes the outer unread ranking', async () => {
    await harness.render();
    const before = allIds();
    await presence('', 0);
    expect(allIds()).toEqual(before);
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the confirmed mode and reading position when saving fails', async () => {
    await harness.render();
    await presence('c');
    failSave = true;
    await select('running-first');
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(memberSort).toEqual({});
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('未能保存');
  });

  it('restores the confirmed sorting preference after a fresh mount', async () => {
    memberSort = { [anchor]: 'running-first' };
    open = { [anchor]: false };
    await harness.render();
    await presence('c');
    await toggle();
    expect(ids()).toEqual(['c', 'a', 'b']);
  });

  it('uses the same sorting and reading boundaries in projects and starts fresh after changing tabs', async () => {
    await harness.render();
    await presence('c');
    await select('running-first');
    const tab = async (name: string) => {
      await act(async () =>
        [...harness.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          .find((el) => el.textContent?.includes(name))
          ?.click(),
      );
      await harness.flush();
    };
    await tab('项目');
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[aria-label="展开全部项目"]')?.click());
    await harness.flush();
    expect(ids()).toEqual(['c', 'a', 'b']);
    const before = allIds();
    await presence('b', 0);
    expect(allIds()).toEqual(before);
    await tab('置顶');
    expect(ids()).toEqual(['b', 'a', 'c']);
    await tab('项目');
    expect(ids()).toEqual(['b', 'a', 'c']);
  });

  it('keeps positions inside the virtual list while a running member finishes', async () => {
    mockStore.threads = [
      ...(mockStore.threads as object[]),
      ...Array.from({ length: 250 }, (_, index) => ({
        id: `extra-${index}`,
        title: `历史 ${index}`,
        participants: [],
        createdBy: 'user',
        createdAt: 1,
        lastActiveAt: 1,
        pinned: true,
        projectPath: '/project',
      })),
    ];
    await harness.render();
    expect(harness.container.querySelector('[data-testid="virtual-attention-list"]')).not.toBeNull();
    await presence('c');
    await select('running-first');
    const before = allIds();
    await presence('', 0);
    expect(allIds()).toEqual(before);
    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(header()?.textContent).not.toContain('进行中');
  });
});
