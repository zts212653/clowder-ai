import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import {
  addToastMock,
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockPush,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const thread = {
  id: 'identity-delete',
  title: '待清理会话',
  projectPath: '/project/quick-delete',
  createdBy: 'owner',
  participants: [],
  createdAt: 1000,
  lastActiveAt: 1000,
};

describe('thread deletion identity boundary', () => {
  let harness: ThreadSidebarHarness;
  let probeRoot: Root | undefined;
  let probeContainer: HTMLDivElement | undefined;
  const confirm = () =>
    Array.from(harness.container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '移入回收站',
    )!;

  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    observeApiSessionOwner('owner');
    Object.assign(mockStore, {
      threads: [thread],
      currentThreadId: 'default',
      threadStates: {},
      isLoadingThreads: false,
    });
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      if (path === '/api/session') return jsonOk({ userId: 'owner' });
      return defaultSidebarApiMock(path);
    });
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    if (probeRoot) act(() => probeRoot?.unmount());
    probeRoot = undefined;
    probeContainer?.remove();
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { owners: ['another-user'] },
    { owners: [null] },
    { owners: ['another-user', 'owner'] },
  ])('discards an open confirmation when identity changes through $owners', async ({ owners }) => {
    await harness.render();
    const save = vi.spyOn(window.localStorage, 'setItem');
    act(() => harness.container.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    act(() =>
      Array.from(harness.container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === '删除对话')!
        .click(),
    );
    act(() => owners.forEach(observeApiSessionOwner));
    expect(harness.container.querySelector('[role="dialog"]')).toBeNull();
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    act(() => harness.container.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    act(() =>
      Array.from(harness.container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === '删除对话')!
        .click(),
    );
    expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('does not execute a retained confirmation callback under a new identity', async () => {
    const { useThreadDeletion } = await import('../use-thread-deletion');
    await harness.render();
    let deletion: ReturnType<typeof useThreadDeletion> | undefined;
    function Probe() {
      deletion = useThreadDeletion({
        currentThreadId: 'default',
        navigateToThread: mockPush,
        showTrash: false,
        loadTrash: async () => {},
      });
      return null;
    }
    probeContainer = document.createElement('div');
    document.body.appendChild(probeContainer);
    probeRoot = createRoot(probeContainer);
    act(() => probeRoot?.render(<Probe />));
    act(() => deletion!.requestDelete(thread.id));
    const oldConfirm = deletion!.confirmDelete;
    act(() => observeApiSessionOwner('another-user'));
    await act(async () => oldConfirm());
    await harness.flush();
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  });

  it('does not navigate or show feedback after identity changes during deletion', async () => {
    mockStore.currentThreadId = thread.id;
    await harness.render();
    const save = vi.spyOn(window.localStorage, 'setItem');
    const originalFetch = mockApiFetch.getMockImplementation()!;
    let finishDelete: (response: Response) => void = () => {};
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? new Promise<Response>((resolve) => {
            finishDelete = resolve;
          })
        : originalFetch(path, init),
    );
    act(() => harness.container.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    act(() =>
      Array.from(harness.container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === '删除对话')!
        .click(),
    );
    await act(async () => confirm().click());
    act(() => observeApiSessionOwner('another-user'));
    await act(async () => finishDelete(new Response(null, { status: 204 })));
    await harness.flush();
    expect(save).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(addToastMock).not.toHaveBeenCalled();
  });

  it.each([
    'sidebar',
    'trash',
  ])('does not continue old UI effects after identity changes during %s refresh', async (stage) => {
    await harness.render();
    act(() => harness.container.querySelector<HTMLButtonElement>('[data-testid="trash-bin-toggle"]')!.click());
    await harness.flush();
    const originalFetch = mockApiFetch.getMockImplementation()!;
    const captured = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<Response>();
    const blockedPath = stage === 'sidebar' ? '/api/threads?view=sidebar' : '/api/threads?deleted=true';
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === blockedPath) {
        captured.resolve();
        return delivery.promise;
      }
      return originalFetch(path, init);
    });
    act(() => harness.container.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click());
    act(() =>
      Array.from(harness.container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === '删除对话')!
        .click(),
    );
    await act(async () => confirm().click());
    await captured.promise;
    const trashReadsBeforeChange = mockApiFetch.mock.calls.filter(
      ([path]) => path === '/api/threads?deleted=true',
    ).length;
    act(() => observeApiSessionOwner('another-user'));
    await act(async () => delivery.resolve(Response.json({ threads: [] })));
    await harness.flush();
    expect(addToastMock).not.toHaveBeenCalled();
    expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/threads?deleted=true')).toHaveLength(
      trashReadsBeforeChange,
    );
  });
});
