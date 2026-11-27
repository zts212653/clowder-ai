import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markApiGetGeneration } from '@/utils/api-get-generation';

const mockApiFetch = vi.fn();
const mockApplySidebarSnapshot = vi.fn(() => true);
const mockSetRefreshing = vi.fn();
const mockLoadSidebarSnapshot = vi.fn();
const mockSetThreads = vi.fn();
const mockInitThreadUnread = vi.fn();
const mockSetLoadingThreads = vi.fn();
const mockFailSidebarCommand = vi.fn();
const mockUpdateThreadTitle = vi.fn();
let confirmedSidebarCommands: Record<
  string,
  {
    id: string;
    threadId: string;
    field: string;
    value: string;
    confirmed?: boolean;
  }
> = {};
let rows: { id: string; title: string }[] = [];

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
      pendingThreadCommands: confirmedSidebarCommands,
      rows,
      failSidebarCommand: mockFailSidebarCommand,
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
      updateThreadTitle: mockUpdateThreadTitle,
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

function ok(threads: unknown[], generation = ++nextMockGetGeneration, etag?: string) {
  const response = new Response(JSON.stringify({ threads }), {
    status: 200,
    headers: etag ? { etag } : undefined,
  });
  markApiGetGeneration(response, generation);
  return response;
}

function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { etag } });
}

describe('sidebar snapshot refresh controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSidebarRefreshForTests();
    nextMockGetGeneration = 0;
    confirmedSidebarCommands = {};
    rows = [];
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

  it('retires unchanged invalidations on 304 without parsing or applying the snapshot', async () => {
    const etag = '"sidebar-v1"';
    const unchanged = notModified(etag);
    const parse304 = vi.spyOn(unchanged, 'json');
    mockApiFetch.mockResolvedValueOnce(ok([{ id: 'canonical' }], 1, etag)).mockResolvedValueOnce(unchanged);

    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(true);
    await expect(invalidateSidebarProjection()).resolves.toBe(true);

    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/threads?view=sidebar', undefined, {
      afterCurrentGet: true,
      ifNoneMatch: etag,
    });
    expect(parse304).not.toHaveBeenCalled();
    expect(mockApplySidebarSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSetThreads).toHaveBeenCalledTimes(1);
    expect(mockInitThreadUnread).toHaveBeenCalledTimes(0);
    expect(mockSetLoadingThreads).toHaveBeenCalledTimes(1);
    expect(mockSetRefreshing).toHaveBeenLastCalledWith(false);
  });

  it('skips JSON parse and every apply side effect when a 200 repeats the same representation identity', async () => {
    const etag = '"sidebar-v1"';
    const duplicate = new Response('not-json-by-design', { status: 200, headers: { etag } });
    const parseDuplicate = vi.spyOn(duplicate, 'json');
    mockApiFetch.mockResolvedValueOnce(ok([{ id: 'canonical' }], 1, etag)).mockResolvedValueOnce(duplicate);

    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(true);
    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(true);

    expect(parseDuplicate).not.toHaveBeenCalled();
    expect(mockApplySidebarSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSetThreads).toHaveBeenCalledTimes(1);
    expect(mockSetLoadingThreads).toHaveBeenCalledTimes(1);
  });

  it('hydrates legacy Chat owners only after the canonical snapshot is accepted', async () => {
    const threads = [
      {
        id: 'bedroom',
        projectPath: '/tmp/cat-cafe',
        title: 'Bedroom',
        createdBy: 'operator',
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
          createdBy: 'operator',
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

  it('retires only rename receipts covered by a successful post-write sidebar read, including after a failed refresh', async () => {
    const old = deferred<Response>();
    const postWrite = deferred<Response>();
    mockApiFetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(postWrite.promise);
    const staleRead = refreshSidebarThreadSnapshot();
    confirmedSidebarCommands = {
      rename: { id: 'local-receipt', field: 'title', threadId: 'thread', value: 'local confirmed', confirmed: true },
    };
    const revalidation = invalidateSidebarProjection();
    old.resolve(ok([{ id: 'thread', title: 'before the rename' }], 1));
    await expect(staleRead).resolves.toBe(true);
    expect(mockFailSidebarCommand).not.toHaveBeenCalled();

    postWrite.resolve(new Response(null, { status: 500 }));
    await expect(revalidation).resolves.toBe(false);
    expect(mockFailSidebarCommand).not.toHaveBeenCalled();

    const serverTitle = { id: 'thread', title: 'remote latest' };
    rows = [serverTitle];
    mockApiFetch.mockResolvedValueOnce(ok(rows, 3));
    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(true);
    expect(mockApiFetch).toHaveBeenNthCalledWith(3, '/api/threads?view=sidebar', undefined, { afterCurrentGet: true });
    expect(mockFailSidebarCommand).toHaveBeenCalledWith('local-receipt');
    expect(mockUpdateThreadTitle).toHaveBeenLastCalledWith('thread', 'remote latest');
  });

  it('lets a fresh 304 confirm the canonical title without parsing the snapshot again', async () => {
    rows = [{ id: 'thread', title: 'remote latest' }];
    mockApiFetch.mockResolvedValueOnce(ok(rows, 1, '"latest"'));
    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(true);
    confirmedSidebarCommands = {
      rename: { id: 'local-receipt', field: 'title', threadId: 'thread', value: 'local confirmed', confirmed: true },
    };
    mockApiFetch.mockResolvedValueOnce(notModified('"latest"'));

    await expect(invalidateSidebarProjection()).resolves.toBe(true);
    expect(mockApplySidebarSnapshot).toHaveBeenCalledOnce();
    expect(mockFailSidebarCommand).toHaveBeenCalledWith('local-receipt');
    expect(mockUpdateThreadTitle).toHaveBeenLastCalledWith('thread', 'remote latest');
  });
});
