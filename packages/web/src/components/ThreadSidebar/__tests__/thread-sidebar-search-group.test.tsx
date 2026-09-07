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

describe('F277 search Group production journey', () => {
  let harness: ThreadSidebarHarness;
  const makeThread = (id: string, title: string, pinned = false): Thread => ({
    id,
    title,
    pinned,
    createdBy: 'user',
    createdAt: 1,
    lastActiveAt: 1,
    projectPath: '/project',
    participants: [],
  });
  const groups = [{ id: 'attention_other', name: '另一个 Group', threadIds: ['thread_c', 'thread_d'] }];
  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'pinned');
    Object.assign(mockStore, {
      threads: [
        makeThread('thread_a', 'F311 产品', true),
        makeThread('thread_b', 'F311 实现'),
        makeThread('thread_c', 'F311 review'),
        makeThread('thread_d', '另一组成员'),
        makeThread('thread_wrong', 'F3110 不能混入', true),
        { ...makeThread('thread_system', 'F311 系统'), systemKind: 'eval_domain' },
      ],
      currentThreadId: 'thread_a',
      threadStates: {},
      isLoadingThreads: false,
    });
    useLabelStore.setState({ labels: [], isLoading: false });
    mockApiFetch.mockImplementation((path: string) =>
      path === '/api/config/thread-attention' ? jsonOk({ aliases: {}, open: {}, groups }) : defaultSidebarApiMock(path),
    );
    harness = createThreadSidebarHarness();
  });
  afterEach(() => {
    harness.cleanup();
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });
  async function setInput(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await harness.flush();
  }
  async function start() {
    await harness.render();
    await harness.flush();
    await setInput(harness.container.querySelector('input[placeholder="搜索对话、项目或 ID..."]')!, 'f311');
    const button = harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-organize"]');
    expect(button?.textContent).toContain('整理全部 3 条');
    await act(async () => button?.click());
    await harness.flush();
  }
  function commandBodies() {
    return mockApiFetch.mock.calls
      .filter(([path, init]) => path === '/api/config/thread-attention/groups' && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)));
  }

  it('opens all ordinary matches from pinned search with no writes and preserves existing groups by default', async () => {
    await start();
    const editor = harness.container.querySelector('[data-testid="search-group-editor"]');
    expect(editor?.textContent).toContain('F311 实现');
    expect(editor?.textContent).not.toContain('F3110');
    expect(editor?.textContent).not.toContain('F311 系统');
    expect(editor?.textContent).toContain('另一个 Group');
    expect(editor?.querySelector<HTMLInputElement>('[data-select-thread="thread_a"]')?.checked).toBe(true);
    expect(editor?.querySelector<HTMLInputElement>('[data-select-thread="thread_b"]')?.checked).toBe(true);
    expect(editor?.querySelector<HTMLInputElement>('[data-select-thread="thread_c"]')?.checked).toBe(false);
    expect(commandBodies()).toEqual([]);
    expect(mockStore.currentThreadId).toBe('thread_a');
  });

  it('keeps editable selection and name after failure, then submits exact members on retry', async () => {
    await start();
    await setInput(harness.container.querySelector('input[aria-label="Group 名称"]')!, '发布工作台');
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/thread-attention/groups' && init?.method === 'POST') return textFail(500, 'failed');
      return path === '/api/config/thread-attention'
        ? jsonOk({ aliases: {}, open: {}, groups })
        : defaultSidebarApiMock(path);
    });
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-save"]')?.click(),
    );
    await harness.flush();
    expect(harness.container.querySelector('[data-testid="search-group-editor"]')).not.toBeNull();
    expect(harness.container.querySelector<HTMLInputElement>('input[aria-label="Group 名称"]')?.value).toBe(
      '发布工作台',
    );
    expect(harness.container.textContent).toContain('重试');
    expect(commandBodies()[0]).toMatchObject({
      action: 'organize',
      threadIds: ['thread_a', 'thread_b'],
      name: '发布工作台',
      expectedGroups: [],
    });
    expect((mockStore.threads as Thread[]).find((thread: Thread) => thread.id === 'thread_b')?.pinned).toBe(false);
  });

  it('shows the cross-pin tip and keeps an explicit dismissal after remount', async () => {
    await start();
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-cancel"]')?.click(),
    );
    await harness.flush();
    expect(harness.container.querySelector('[data-testid="search-group-tip"]')?.textContent).toContain('未置顶');
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[aria-label="关闭搜索整理提示"]')?.click(),
    );
    await harness.flush();
    harness.cleanup();
    harness = createThreadSidebarHarness();
    await harness.render();
    await harness.flush();
    await setInput(harness.container.querySelector('input[placeholder="搜索对话、项目或 ID..."]')!, 'f311');
    expect(harness.container.querySelector('[data-testid="search-group-tip"]')).toBeNull();
  });
  it('saves once while pending, reveals the complete pinned Group and sends its exact undo receipt', async () => {
    await start();
    const savedGroups = [...groups, { id: 'attention_saved', name: 'F311', threadIds: ['thread_a', 'thread_b'] }];
    const undo = {
      proof: 'a'.repeat(64),
      entries: ['thread_a', 'thread_b'].map((threadId, order) => ({
        threadId,
        before: null,
        after: { v: 1, groupId: 'attention_saved', order },
      })),
    };
    let resolveSave!: (response: Response) => void;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/thread-attention/groups') {
        const command = JSON.parse(String(init?.body));
        return command.action === 'organize'
          ? new Promise<Response>((resolve) => {
              resolveSave = resolve;
            })
          : jsonOk({ aliases: {}, open: {}, groups });
      }
      if (path === '/api/config/thread-attention')
        return jsonOk({ aliases: {}, open: { 'group:attention_saved': true }, groups: savedGroups });
      return defaultSidebarApiMock(path);
    });
    const save = harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-save"]')!;
    await act(async () => {
      save.click();
      save.click();
    });
    expect(commandBodies()).toHaveLength(1);
    expect(harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-cancel"]')?.disabled).toBe(
      true,
    );
    await act(async () => resolveSave(await jsonOk({ aliases: {}, open: {}, groups: savedGroups, undo })));
    await harness.flush();
    expect(harness.container.querySelector('[data-testid="search-group-editor"]')).toBeNull();
    expect(harness.container.querySelector('[data-attention-cluster="group:attention_saved"]')).not.toBeNull();
    expect(harness.container.querySelector('[data-thread-id="thread_b"]')).not.toBeNull();
    expect(mockStore.currentThreadId).toBe('thread_a');
    expect((mockStore.threads as Thread[]).find((thread) => thread.id === 'thread_b')?.pinned).toBe(false);
    expect(harness.container.textContent).toContain('已整理 2 条');
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-undo"]')?.click(),
    );
    await harness.flush();
    expect(commandBodies()[1]).toEqual({ action: 'undo', ...undo });
    expect(harness.container.textContent).toContain('已撤销本次整理');
  });

  it('adds to an existing Group with its observed membership and explains an explicit move', async () => {
    await start();
    await act(async () =>
      harness.container.querySelector<HTMLInputElement>('[data-select-thread="thread_c"]')?.click(),
    );
    expect(harness.container.textContent).toContain('将从「另一个 Group」移到「F311」');
    await act(async () =>
      harness.container.querySelector<HTMLInputElement>('[data-select-thread="thread_c"]')?.click(),
    );
    mockApiFetch.mockImplementation((path: string) =>
      path.endsWith('/groups') ? textFail(500, 'retry') : jsonOk({ aliases: {}, open: {}, groups }),
    );
    const select = harness.container.querySelector<HTMLSelectElement>('select[aria-label="整理目标"]')!;
    await act(async () => {
      select.value = 'attention_other';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(harness.container.querySelector<HTMLInputElement>('[data-select-thread="thread_c"]')?.disabled).toBe(true);
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-save"]')?.click(),
    );
    await harness.flush();
    expect(commandBodies()[0]).toMatchObject({
      action: 'organize',
      groupId: 'attention_other',
      threadIds: ['thread_a', 'thread_b'],
      expectedGroups: [{ id: 'attention_other', threadIds: ['thread_c', 'thread_d'] }],
    });
    expect(commandBodies()[0]).not.toHaveProperty('name');
  });

  it('ends undo after a member disappears instead of offering an impossible retry', async () => {
    await start();
    const undo = {
      proof: 'a'.repeat(64),
      entries: ['thread_a', 'thread_b'].map((threadId, order) => ({
        threadId,
        before: null,
        after: { v: 1, groupId: 'attention_saved', order },
      })),
    };
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/thread-attention/groups') {
        const command = JSON.parse(String(init?.body));
        return command.action === 'undo'
          ? textFail(409, 'member disappeared')
          : jsonOk({
              aliases: {},
              open: {},
              groups: [...groups, { id: 'attention_saved', name: 'F311', threadIds: ['thread_a', 'thread_b'] }],
              undo,
            });
      }
      return path === '/api/config/thread-attention'
        ? jsonOk({ aliases: {}, open: {}, groups })
        : defaultSidebarApiMock(path);
    });
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-save"]')?.click(),
    );
    await harness.flush();
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-undo"]')?.click(),
    );
    await harness.flush();
    const feedback = harness.container.querySelector('[data-testid="search-group-success"]');
    expect(feedback?.textContent).toContain('本次整理已无法撤销，当前分组保持不变。');
    expect(feedback?.textContent).not.toContain('重试');
    expect(feedback?.querySelector('[data-testid="search-group-undo"]')).toBeNull();
    expect(commandBodies().map(({ action }) => action)).toEqual(['organize', 'undo']);
  });

  it('requires a fresh membership read after a conflict and keeps ordinary failures retryable', async () => {
    await start();
    mockApiFetch.mockImplementation((path: string) =>
      path.endsWith('/groups') ? textFail(409, 'changed') : jsonOk({ aliases: {}, open: {}, groups }),
    );
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-save"]')?.click(),
    );
    await harness.flush();
    expect(harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-save"]')?.disabled).toBe(
      true,
    );
    const reload = [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '重新查看',
    );
    await act(async () => reload?.click());
    await harness.flush();
    expect(harness.container.querySelector<HTMLInputElement>('[data-select-thread="thread_a"]')?.checked).toBe(false);
    expect(commandBodies()).toHaveLength(1);
  });

  it('does not treat an unread Group collection as unclaimed membership', async () => {
    mockApiFetch.mockImplementation((path: string) =>
      path === '/api/config/thread-attention' ? textFail(500, 'failed') : defaultSidebarApiMock(path),
    );
    await harness.render();
    await harness.flush();
    await setInput(harness.container.querySelector('input[placeholder="搜索对话、项目或 ID..."]')!, 'f311');
    const action = harness.container.querySelector<HTMLButtonElement>('[data-testid="search-group-organize"]');
    expect(action?.textContent).toContain('读取 Group 失败');
    await act(async () => action?.click());
    await harness.flush();
    expect(harness.container.querySelector('[data-testid="search-group-editor"]')).toBeNull();
    expect(commandBodies()).toEqual([]);
  });
});
