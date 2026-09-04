import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/stores/chat-types';
import { useLabelStore } from '@/stores/label-store';
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
  textFail,
} from './thread-sidebar-test-helpers';

const NOW = 1710000000000;

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    projectPath: '/project',
    title: overrides.id,
    createdBy: 'user',
    participants: [],
    lastActiveAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

const relationProjection = {
  v: 1,
  nodes: [
    { threadId: 'child-a', placement: { parentThreadId: 'root-a', declaredWorkMode: 'parallel' } },
    { threadId: 'child-b', placement: { parentThreadId: 'root-b', declaredWorkMode: 'investigation' } },
  ],
};

const explicitGroups = [
  { id: 'attention_a', threadIds: ['root-a', 'child-a'] },
  { id: 'attention_b', threadIds: ['root-b', 'child-b'] },
];

async function enterSearch(container: HTMLElement, query: string, flush: () => Promise<void>) {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="搜索对话、项目或 ID..."]');
  if (!input) throw new Error('sidebar search input not found');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

describe('F277 production Sidebar attention clusters', () => {
  let harness: ThreadSidebarHarness;

  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
    Object.assign(mockStore, {
      threads: [
        makeThread({ id: 'default', title: '大厅', projectPath: 'default' }),
        makeThread({ id: 'root-a', title: 'F296 · Continuity', lastActiveAt: NOW - 2_000 }),
        makeThread({ id: 'child-a', title: 'F296 Alpha 五旅程', pinned: true, lastActiveAt: NOW - 1_000 }),
        makeThread({ id: 'root-b', title: 'F277 · 注意力导航', lastActiveAt: NOW - 4_000 }),
        makeThread({ id: 'child-b', title: 'F277 视觉裁决', lastActiveAt: NOW - 3_000 }),
      ],
      currentThreadId: 'child-a',
      threadStates: {},
      isLoadingThreads: false,
    });
    useLabelStore.setState({ labels: [], isLoading: false });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/threads/relations') return jsonOk(relationProjection);
      if (path === '/api/config/thread-attention') {
        return jsonOk({ aliases: { 'group:attention_b': '注意力导航收口' }, open: {}, groups: explicitGroups });
      }
      return defaultSidebarApiMock(path);
    });
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
    harness.cleanup();
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });

  it('expands the current Group and folds another explicit Group into one scan unit', async () => {
    await harness.render();
    await harness.flush();

    const current = harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_a"]');
    const other = harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_b"]');
    expect(current?.dataset.expanded).toBe('true');
    expect(
      harness.container.querySelectorAll('[data-attention-cluster-member="group:attention_a"] [data-thread-id]'),
    ).toHaveLength(2);
    expect(other?.dataset.expanded).toBe('false');
    expect(current?.textContent).toContain('Group');
    expect(
      harness.container.querySelectorAll('[data-attention-cluster-member="group:attention_b"] [data-thread-id]'),
    ).toHaveLength(0);
    expect(other?.textContent).toContain('2 个对话');
  });

  it('keeps the default Sidebar unchanged when exact relations exist but no Group metadata does', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/threads/relations') return jsonOk(relationProjection);
      if (path === '/api/config/thread-attention') return jsonOk({ aliases: {}, open: {}, groups: [] });
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await harness.flush();

    expect(harness.container.querySelector('[data-attention-cluster]')).toBeNull();
    expect(harness.container.querySelector('[data-thread-id="root-a"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-thread-id="child-a"]')).not.toBeNull();
    expect(mockApiFetch.mock.calls.some(([path]) => path === '/api/threads/relations')).toBe(false);
  });

  it('keeps an expanded cluster visually continuous instead of falling back to separate thread cards', async () => {
    await harness.render();
    await harness.flush();

    const header = harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_a"]');
    const members = Array.from(
      harness.container.querySelectorAll<HTMLElement>('[data-attention-cluster-member="group:attention_a"]'),
    );

    expect(header?.dataset.clusterSegment).toBe('start');
    expect(members.map((member) => member.dataset.clusterSegment)).toEqual(['middle', 'end']);
    expect(members.every((member) => member.classList.contains('!mt-0'))).toBe(true);
    expect(members.every((member) => !member.classList.contains('bg-cafe-surface-elevated'))).toBe(true);
    expect(members.every((member) => member.querySelector('[data-cluster-rail="true"]'))).toBe(true);
    const lastRail = members.at(-1)?.querySelector<HTMLElement>('[data-cluster-rail="true"]');
    expect(lastRail?.classList.contains('h-[36px]')).toBe(true);
    expect(lastRail?.classList.contains('bottom-10')).toBe(false);
  });

  it('search recalls a folded member and pinned view keeps the full Group closure', async () => {
    await harness.render();
    await harness.flush();
    await enterSearch(harness.container, '视觉裁决', harness.flush);

    const recalled = harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_b"]');
    expect(recalled?.dataset.expanded).toBe('true');
    expect(
      harness.container.querySelector('[data-attention-cluster-member="group:attention_b"] [data-thread-id="child-b"]'),
    ).not.toBeNull();

    await enterSearch(harness.container, '', harness.flush);
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'pinned');
    const pinnedTab = harness.container.querySelector<HTMLButtonElement>('[data-testid="sidebar-tab-pinned"]');
    await act(async () => pinnedTab?.click());
    await harness.flush();

    const pinnedCluster = harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_a"]');
    expect(pinnedCluster?.textContent).toContain('1 个置顶');
    expect(pinnedCluster?.textContent).toContain('2 个对话');
    expect(
      harness.container.querySelector('[data-attention-cluster-member="group:attention_a"] [data-thread-id="root-a"]'),
    ).not.toBeNull();
    expect(
      harness.container.querySelector('[data-attention-cluster-member="group:attention_a"] [data-thread-id="child-a"]'),
    ).not.toBeNull();
  });

  it('persists the inverse of the search-forced visible state when the user toggles a cluster', async () => {
    const mutations: unknown[] = [];
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/threads/relations') return jsonOk(relationProjection);
      if (path === '/api/config/thread-attention' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        mutations.push(body);
        return jsonOk({ aliases: {}, open: { [body.anchor]: body.open }, groups: explicitGroups });
      }
      if (path === '/api/config/thread-attention') return jsonOk({ aliases: {}, open: {}, groups: explicitGroups });
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await harness.flush();
    await enterSearch(harness.container, '视觉裁决', harness.flush);

    const recalled = harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_b"]');
    expect(recalled?.dataset.expanded).toBe('true');
    const toggle = recalled?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]');
    await act(async () => toggle?.click());
    await harness.flush();

    expect(mutations).toContainEqual({ anchor: 'group:attention_b', open: false });
    await enterSearch(harness.container, '', harness.flush);
    expect(
      harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_b"]')?.dataset.expanded,
    ).toBe('false');
  });

  it('does not mutate the cache or visible cluster state when canonical persistence fails', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/threads/relations') return jsonOk(relationProjection);
      if (path === '/api/config/thread-attention' && init?.method === 'PUT') return textFail(403, 'forbidden');
      if (path === '/api/config/thread-attention') return jsonOk({ aliases: {}, open: {}, groups: explicitGroups });
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await harness.flush();

    const folded = harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_b"]');
    const toggle = folded?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    await act(async () => toggle?.click());
    await harness.flush();

    expect(
      harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_b"]')?.dataset.expanded,
    ).toBe('false');
    expect(window.localStorage.getItem('cat-cafe:f277:cluster-open:v1')).toBe('{}');
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('未能保存');
  });

  it('renders the durable private alias and can reset it to the first exact title fallback', async () => {
    const mutations: Array<{ path: string; body: unknown }> = [];
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/threads/relations') return jsonOk(relationProjection);
      if (path === '/api/config/thread-attention/groups' && init?.method === 'POST') {
        mutations.push({ path, body: JSON.parse(String(init.body)) });
        return jsonOk({ aliases: {}, open: {}, groups: explicitGroups });
      }
      if (path === '/api/config/thread-attention') {
        return jsonOk({ aliases: { 'group:attention_b': '注意力导航收口' }, open: {}, groups: explicitGroups });
      }
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await harness.flush();

    const group = harness.container.querySelector<HTMLElement>('[data-attention-cluster="group:attention_b"]');
    expect(group?.textContent).toContain('注意力导航收口');
    const rename = group?.querySelector<HTMLButtonElement>('button[aria-label^="重命名"]');
    await act(async () => rename?.click());
    const reset = [...(group?.querySelectorAll('button') ?? [])].find((button) => button.textContent === '恢复名称');
    await act(async () => reset?.click());
    await harness.flush();

    expect(mutations).toContainEqual({
      path: '/api/config/thread-attention/groups',
      body: { action: 'rename', groupId: 'attention_b', name: null },
    });
    expect(group?.textContent).toContain('F277 · 注意力导航');
  });

  it('uses the same canonical command when one production ThreadItem is dragged onto another', async () => {
    const mutations: unknown[] = [];
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/threads/relations') return jsonOk({ v: 1, nodes: [] });
      if (path === '/api/config/thread-attention/groups' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        mutations.push(body);
        return jsonOk({
          aliases: {},
          open: {},
          groups: [
            {
              id: 'attention_manual',
              threadIds: ['root-b', 'child-a'],
            },
          ],
        });
      }
      if (path === '/api/config/thread-attention') return jsonOk({ aliases: {}, open: {}, groups: [] });
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await harness.flush();

    const source = harness.container.querySelector<HTMLElement>('[data-attention-draggable-thread="child-a"]');
    const target = harness.container.querySelector<HTMLElement>('[data-attention-draggable-thread="root-b"]');
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();

    await act(async () => {
      source?.dispatchEvent(new Event('dragstart', { bubbles: true }));
      target?.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
      target?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });
    await harness.flush();

    expect(mutations).toContainEqual({ action: 'create', threadIds: ['root-b', 'child-a'] });
    const savedGroup = harness.container.querySelector<HTMLElement>(
      '[data-attention-cluster="group:attention_manual"]',
    );
    expect(savedGroup).not.toBeNull();
    expect(savedGroup?.textContent).toContain('Group');
    expect(savedGroup?.textContent).not.toContain('我的组');
  });

  it('enters the same arrange mode after a deliberate long press without creating a group', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/threads/relations') return jsonOk({ v: 1, nodes: [] });
      if (path === '/api/config/thread-attention') return jsonOk({ aliases: {}, open: {}, groups: [] });
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await harness.flush();
    vi.useFakeTimers();

    const source = harness.container.querySelector<HTMLElement>('[data-attention-draggable-thread="child-a"]');
    await act(async () => {
      source?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      vi.advanceTimersByTime(500);
    });

    expect(source?.dataset.attentionArranging).toBe('true');
    expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/config/thread-attention/groups')).toHaveLength(0);
    vi.useRealTimers();
  });

  it('offers the same durable create command from the ThreadItem menu fallback', async () => {
    const mutations: unknown[] = [];
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/labels') return jsonOk([]);
      if (path === '/api/threads/relations') return jsonOk({ v: 1, nodes: [] });
      if (path === '/api/config/thread-attention/groups' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        mutations.push(body);
        return jsonOk({
          aliases: {},
          open: {},
          groups: [{ id: 'attention_menu', threadIds: body.threadIds }],
        });
      }
      if (path === '/api/config/thread-attention') return jsonOk({ aliases: {}, open: {}, groups: [] });
      return defaultSidebarApiMock(path);
    });
    await harness.render();
    await harness.flush();

    const thread = harness.container.querySelector<HTMLElement>('[data-thread-id="root-b"]');
    await act(async () => thread?.querySelector<HTMLButtonElement>('button[title="更多操作"]')?.click());
    const menuText = thread?.querySelector<HTMLElement>('[role="menu"]')?.textContent ?? '';
    for (const action of ['对话设置', '整理 Group', '重命名对话', '导出对话', '回放剧场', '收藏', '删除对话']) {
      expect(menuText).toContain(action);
    }
    const organize = [...(thread?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === '整理 Group',
    );
    await act(async () => organize?.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('与另一条对话新建 Group');
    const create = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === '新建 Group',
    );
    await act(async () => create?.click());
    await harness.flush();

    expect(mutations).toContainEqual({ action: 'create', threadIds: ['root-a', 'root-b'] });
  });
});
