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
  const quickDelete = () => harness.container.querySelector<HTMLButtonElement>('[data-testid="thread-quick-delete"]')!;
  const remember = () => harness.container.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;
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
    act(() => quickDelete().click());
    act(() => remember().click());
    act(() => owners.forEach(observeApiSessionOwner));
    expect(harness.container.querySelector('[role="dialog"]')).toBeNull();
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
    act(() => quickDelete().click());
    expect(remember().checked).toBe(false);
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
    await act(async () => oldConfirm(true));
    await harness.flush();
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  });

  it('does not save an old choice or navigate after identity changes during deletion', async () => {
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
    act(() => quickDelete().click());
    act(() => remember().click());
    await act(async () => confirm().click());
    act(() => observeApiSessionOwner('another-user'));
    await act(async () => finishDelete(new Response(null, { status: 204 })));
    await harness.flush();
    expect(save).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(addToastMock).not.toHaveBeenCalled();
  });
});
