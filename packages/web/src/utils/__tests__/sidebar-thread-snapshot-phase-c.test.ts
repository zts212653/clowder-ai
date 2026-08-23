import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markApiGetGeneration } from '@/utils/api-get-generation';

const mockApiFetch = vi.fn();
const mockApplySidebarSnapshot = vi.fn(() => true);
const mockSetRefreshing = vi.fn();
const mockLoadSidebarSnapshot = vi.fn();
const mockSetThreads = vi.fn();
const mockInitThreadUnread = vi.fn();
const mockSetLoadingThreads = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/utils/offline-store', () => ({
  loadSidebarSnapshot: () => mockLoadSidebarSnapshot(),
}));

vi.mock('@/stores/sidebarProjectionStore', () => ({
  parseSidebarSnapshotRows: (value: unknown) => value,
  useSidebarProjectionStore: {
    getState: () => ({
      applySidebarSnapshot: mockApplySidebarSnapshot,
      setRefreshing: mockSetRefreshing,
    }),
  },
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      setThreads: mockSetThreads,
      initThreadUnread: mockInitThreadUnread,
      setLoadingThreads: mockSetLoadingThreads,
    }),
  },
}));

import {
  __resetSidebarRefreshForTests,
  bootstrapSidebarThreadSnapshot,
  invalidateSidebarProjection,
  refreshSidebarThreadSnapshot,
} from '../sidebar-thread-snapshot';

let nextMockGetGeneration = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ok(threads: unknown[], generation = ++nextMockGetGeneration) {
  const response = new Response(JSON.stringify({ threads }), { status: 200 });
  markApiGetGeneration(response, generation);
  return response;
}

describe('sidebar snapshot refresh controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSidebarRefreshForTests();
    nextMockGetGeneration = 0;
  });

  it('delegates concurrent ordinary refresh callers to the exact-GET coordinator', async () => {
    const responseReady = deferred<void>();
    mockApiFetch.mockImplementation(async () => {
      await responseReady.promise;
      return ok([{ id: 'canonical' }], 1);
    });

    const first = refreshSidebarThreadSnapshot();
    const second = refreshSidebarThreadSnapshot();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/threads?view=sidebar', undefined, {
      afterCurrentGet: false,
    });
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/threads?view=sidebar', undefined, {
      afterCurrentGet: false,
    });

    responseReady.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(mockApplySidebarSnapshot).toHaveBeenCalledTimes(2);
    expect(mockApplySidebarSnapshot).toHaveBeenCalledWith([{ id: 'canonical' }], 1);
  });

  it('requests a bounded trailing generation when invalidated during an in-flight request', async () => {
    const firstResponse = deferred<ReturnType<typeof ok>>();
    const secondResponse = deferred<ReturnType<typeof ok>>();
    mockApiFetch.mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(secondResponse.promise);

    const first = refreshSidebarThreadSnapshot();
    const invalidated = invalidateSidebarProjection();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/threads?view=sidebar', undefined, {
      afterCurrentGet: true,
    });

    firstResponse.resolve(ok([{ id: 'first' }]));
    secondResponse.resolve(ok([{ id: 'second' }]));

    await expect(Promise.all([first, invalidated])).resolves.toEqual([true, true]);
    expect(mockApplySidebarSnapshot.mock.calls).toEqual([
      [[{ id: 'first' }], 1],
      [[{ id: 'second' }], 2],
    ]);
  });

  it('hydrates legacy Chat owners only after the canonical snapshot is accepted', async () => {
    const threads = [
      {
        id: 'bedroom',
        projectPath: '/tmp/cat-cafe',
        title: 'Bedroom',
        createdBy: 'you',
        participants: ['codex-sol'],
        preferredCats: ['codex-sol'],
        lastActiveAt: 20,
        createdAt: 10,
        unreadCount: 2,
        hasUserMention: true,
      },
    ];
    mockApiFetch.mockResolvedValue(ok(threads));

    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(true);

    expect(mockApplySidebarSnapshot).toHaveBeenCalledWith(threads, 1);
    expect(mockSetThreads).toHaveBeenCalledWith(threads);
    expect(mockInitThreadUnread).toHaveBeenCalledWith('bedroom', 2, true);
    expect(mockSetLoadingThreads).toHaveBeenCalledWith(false);
    expect(mockApplySidebarSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetThreads.mock.invocationCallOrder[0],
    );
  });

  it('does not hydrate legacy Chat owners from a rejected stale response', async () => {
    mockApplySidebarSnapshot.mockReturnValueOnce(false);
    mockApiFetch.mockResolvedValue(
      ok([
        {
          id: 'stale',
          projectPath: '/tmp/old',
          title: 'Old',
          createdBy: 'you',
          participants: [],
          lastActiveAt: 1,
          createdAt: 1,
        },
      ]),
    );

    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(false);

    expect(mockSetThreads).not.toHaveBeenCalled();
    expect(mockInitThreadUnread).not.toHaveBeenCalled();
    expect(mockSetLoadingThreads).not.toHaveBeenCalled();
  });

  it('loads cache through the bootstrap generation instead of a legacy store writer', async () => {
    mockLoadSidebarSnapshot.mockResolvedValue([{ id: 'cached' }]);

    await expect(bootstrapSidebarThreadSnapshot()).resolves.toBe(true);
    expect(mockApplySidebarSnapshot).toHaveBeenCalledWith([{ id: 'cached' }], 0, { source: 'cache' });
    expect(mockSetThreads).not.toHaveBeenCalled();
    expect(mockSetLoadingThreads).not.toHaveBeenCalled();
  });
});
