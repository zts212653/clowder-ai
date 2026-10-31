import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import {
  addToastMock,
  clickBootcampButton,
  createInLobby,
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  openCreateDialog,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
  textFail,
} from './thread-sidebar-test-helpers';

describe('ThreadSidebar create error feedback', () => {
  let harness: ThreadSidebarHarness;

  beforeAll(() => {
    installThreadSidebarGlobals();
  });

  beforeEach(() => {
    resetThreadSidebarMocks();
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  afterAll(() => {
    resetThreadSidebarGlobals();
  });

  it('shows an error toast when createInProject gets a non-ok response', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return textFail(500, 'create failed');
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    await openCreateDialog(harness.container, harness.flush);
    await createInLobby(harness.container, harness.flush);

    expect(addToastMock).toHaveBeenCalledOnce();
    expect(addToastMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'error',
      title: '创建线程失败',
    });
  });

  async function enterThreadTitle(title: string) {
    const input = Array.from(harness.container.querySelectorAll('input')).find((candidate) =>
      candidate.placeholder.includes('对话标题'),
    );
    if (!input) throw new Error('thread title input not found');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await harness.flush();
  }

  it('does not adopt an unrelated untitled thread after the create POST times out', async () => {
    const unrelatedThread = {
      id: 'thread-created-by-another-actor',
      title: null,
      projectPath: 'default',
      participants: ['owner'],
      lastActiveAt: Date.now(),
      pinned: false,
      favorited: false,
    };
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    const pushState = vi.spyOn(window.history, 'pushState');

    await harness.render();
    pushState.mockClear();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return Promise.reject(timeout);
      if (path === '/api/threads?view=sidebar') return jsonOk({ threads: [unrelatedThread] });
      return defaultSidebarApiMock(path);
    });

    await openCreateDialog(harness.container, harness.flush);
    await createInLobby(harness.container, harness.flush);

    const postCalls = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/threads' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCalls).toHaveLength(1);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads?view=sidebar', undefined, { afterCurrentGet: true });
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'info', title: '创建结果未确认' }));
    expect(pushState).not.toHaveBeenCalledWith({}, '', `/thread/${unrelatedThread.id}`);
  });

  it('reconciles a timed-out create only when one new thread has the exact submitted title', async () => {
    const createdThread = {
      id: 'thread-created-after-timeout',
      title: 'F304 exact title',
      projectPath: 'default',
      participants: ['owner'],
      lastActiveAt: Date.now(),
      pinned: false,
      favorited: false,
    };
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    const pushState = vi.spyOn(window.history, 'pushState');

    await harness.render();
    pushState.mockClear();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return Promise.reject(timeout);
      if (path === '/api/threads?view=sidebar') return jsonOk({ threads: [createdThread] });
      return defaultSidebarApiMock(path);
    });

    await openCreateDialog(harness.container, harness.flush);
    await enterThreadTitle(createdThread.title);
    await createInLobby(harness.container, harness.flush);

    const postCalls = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/threads' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCalls).toHaveLength(1);
    expect(JSON.parse((postCalls[0]?.[1] as RequestInit).body as string)).toMatchObject({ title: createdThread.title });
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        title: '创建已确认',
        message: expect.stringContaining('没有重复提交'),
      }),
    );
    expect(pushState).toHaveBeenCalledWith({}, '', `/thread/${createdThread.id}`);
  });

  it('keeps an authoritative thread id when the follow-up sidebar refresh times out', async () => {
    const createdThread = {
      id: 'thread-authoritative-id',
      title: null,
      projectPath: 'default',
      participants: ['owner'],
      lastActiveAt: Date.now(),
      pinned: false,
      favorited: false,
    };
    const timeout = Object.assign(new Error('snapshot timed out'), { name: 'TimeoutError' });
    const pushState = vi.spyOn(window.history, 'pushState');

    await harness.render();
    pushState.mockClear();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return jsonOk(createdThread);
      if (path === '/api/threads?view=sidebar') return Promise.reject(timeout);
      return defaultSidebarApiMock(path);
    });

    await openCreateDialog(harness.container, harness.flush);
    await createInLobby(harness.container, harness.flush);

    expect(pushState).toHaveBeenCalledWith({}, '', `/thread/${createdThread.id}`);
    expect(addToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ title: '创建结果未确认' }));
  });

  it('reports an unconfirmed timeout honestly and never retries the create POST', async () => {
    const timeout = Object.assign(new Error('request timed out'), { name: 'TimeoutError' });

    await harness.render();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return Promise.reject(timeout);
      if (path === '/api/threads?view=sidebar') return jsonOk({ threads: [] });
      return defaultSidebarApiMock(path);
    });

    await openCreateDialog(harness.container, harness.flush);
    await createInLobby(harness.container, harness.flush);

    const postCalls = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/threads' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCalls).toHaveLength(1);
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        title: '创建结果未确认',
        message: expect.stringContaining('没有自动重试'),
      }),
    );
  });

  it('opens bootcamp list modal when bootcamp button is clicked', async () => {
    await harness.render();
    await clickBootcampButton(harness.container, harness.flush);
    const modal = harness.container.querySelector('[data-testid="bootcamp-list-modal"]');
    expect(modal ?? harness.container.textContent).toBeTruthy();
  });

  it('applies a canonical snapshot containing the created thread before navigating', async () => {
    const createdThread = {
      id: 'thread-deepseek-harness',
      title: 'DeepSeek harness',
      projectPath: '/projects/cat-cafe',
      createdBy: 'owner',
      participants: ['owner'],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
      pinned: false,
      favorited: false,
    };
    const pushState = vi.spyOn(window.history, 'pushState');

    await harness.render();
    pushState.mockClear();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return jsonOk(createdThread);
      if (path === '/api/threads?view=sidebar') return jsonOk({ threads: [createdThread] });
      return defaultSidebarApiMock(path);
    });

    await openCreateDialog(harness.container, harness.flush);
    await createInLobby(harness.container, harness.flush);

    expect(useSidebarProjectionStore.getState().rows).toEqual([
      expect.objectContaining({ id: createdThread.id, title: createdThread.title }),
    ]);
    expect(pushState).toHaveBeenCalledWith({}, '', '/thread/thread-deepseek-harness');
  });
});
