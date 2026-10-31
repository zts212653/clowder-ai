import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markApiGetGeneration } from '@/utils/api-get-generation';

const mockApiFetch = vi.fn();
const mockSetThreads = vi.fn();
const mockInitThreadUnread = vi.fn();
const mockSetLoadingThreads = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/utils/offline-store', () => ({
  loadSidebarSnapshot: () => Promise.resolve(null),
  saveSidebarSnapshot: () => Promise.resolve(),
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

import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import {
  __resetSidebarRefreshForTests,
  invalidateSidebarProjection,
  refreshSidebarThreadSnapshot,
} from '../sidebar-thread-snapshot';

let nextMockGetGeneration = 0;

function snapshotResponse(threads: unknown[]): Response {
  const response = new Response(JSON.stringify({ threads }), { status: 200 });
  markApiGetGeneration(response, ++nextMockGetGeneration);
  return response;
}

describe('refreshSidebarThreadSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSidebarRefreshForTests();
    nextMockGetGeneration = 0;
    useSidebarProjectionStore.setState({
      rows: [],
      appliedGeneration: 0,
      hasCanonicalSnapshot: false,
      pendingThreadCommands: {},
      refreshing: false,
    });
  });

  it('replaces the canonical projection through an ordinary coordinated GET', async () => {
    const canonicalThreads = [
      {
        id: 'thread-new',
        title: 'Created while disconnected',
        projectPath: 'default',
        participants: ['kimi'],
        lastActiveAt: 123,
        unreadCount: 2,
        hasUserMention: true,
        presence: { status: 'working', cats: ['kimi'] },
      },
    ];
    let resolveFetch!: (value: Response) => void;
    mockApiFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = refreshSidebarThreadSnapshot();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads?view=sidebar', undefined, { afterCurrentGet: false });

    resolveFetch(snapshotResponse(canonicalThreads));

    await expect(first).resolves.toBe(true);
    expect(useSidebarProjectionStore.getState().rows).toEqual([
      expect.objectContaining({
        id: 'thread-new',
        unreadCount: 2,
        hasUserMention: true,
        presence: { status: 'working', cats: ['kimi'] },
      }),
    ]);
    expect(mockSetThreads).toHaveBeenCalledWith(canonicalThreads);
    expect(mockInitThreadUnread).toHaveBeenCalledWith('thread-new', 2, true);
    expect(mockSetLoadingThreads).toHaveBeenCalledWith(false);
  });

  it('routes causal invalidation to a bounded trailing GET generation', async () => {
    mockApiFetch.mockResolvedValue(snapshotResponse([]));

    await expect(invalidateSidebarProjection()).resolves.toBe(true);

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads?view=sidebar', undefined, { afterCurrentGet: true });
  });
});
