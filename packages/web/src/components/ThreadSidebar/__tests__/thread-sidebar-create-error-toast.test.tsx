import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToastMock,
  clickBootcampButton,
  createInLobby,
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
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

  it('shows an error toast when bootcamp thread creation throws', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') {
        return Promise.reject(new Error('network down'));
      }
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    await clickBootcampButton(harness.container, harness.flush);

    expect(addToastMock).toHaveBeenCalledOnce();
    expect(addToastMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'error',
      title: '创建线程失败',
    });
  });
});
