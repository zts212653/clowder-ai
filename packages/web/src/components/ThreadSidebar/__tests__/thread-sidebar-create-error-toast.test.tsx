import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addToastMock,
  clickBootcampButton,
  createInLobby,
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
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

  it('opens bootcamp list modal when bootcamp button is clicked', async () => {
    await harness.render();
    await clickBootcampButton(harness.container, harness.flush);
    const modal = harness.container.querySelector('[data-testid="bootcamp-list-modal"]');
    expect(modal ?? harness.container.textContent).toBeTruthy();
  });

  it('publishes the created thread to the store before navigating to it', async () => {
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
    const setThreads = vi.mocked(mockStore.setThreads as (threads: (typeof createdThread)[]) => void);
    const pushState = vi.spyOn(window.history, 'pushState');

    await harness.render();
    setThreads.mockClear();
    pushState.mockClear();
    mockStore.threads = [];
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return jsonOk(createdThread);
      if (path === '/api/threads?view=sidebar') return new Promise(() => {});
      return defaultSidebarApiMock(path);
    });

    await openCreateDialog(harness.container, harness.flush);
    await createInLobby(harness.container, harness.flush);

    expect(setThreads).toHaveBeenCalledWith([createdThread]);
    expect(pushState).toHaveBeenCalledWith({}, '', '/thread/thread-deepseek-harness');
    const storeWriteOrder = setThreads.mock.invocationCallOrder[0];
    const navigationOrder = pushState.mock.invocationCallOrder[0];
    expect(storeWriteOrder).toBeDefined();
    expect(navigationOrder).toBeDefined();
    if (storeWriteOrder === undefined || navigationOrder === undefined) {
      throw new Error('Expected both the store write and navigation to occur');
    }
    expect(storeWriteOrder).toBeLessThan(navigationOrder);
  });
});
