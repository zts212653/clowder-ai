import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markApiGetGeneration } from '@/utils/api-get-generation';

const mockApiFetch = vi.fn();
const mockSaveSidebarSnapshot = vi.fn(async () => {});
const mockSaveThreads = vi.fn(async () => {});

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/utils/offline-store', () => ({
  loadSidebarSnapshot: vi.fn(async () => null),
  saveSidebarSnapshot: () => mockSaveSidebarSnapshot(),
  saveThreads: () => mockSaveThreads(),
  saveThreadMessages: vi.fn(async () => {}),
  saveThreadWorkspaceState: vi.fn(async () => {}),
}));

import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import {
  __resetSidebarRefreshForTests,
  invalidateSidebarProjection,
  refreshSidebarThreadSnapshot,
} from '../sidebar-thread-snapshot';

const ETAG = '"sidebar-v1"';
const THREADS = [
  {
    id: 'thread-conditional',
    title: 'Conditional snapshot',
    projectPath: '/projects/cat-cafe',
    createdBy: 'alice',
    participants: ['opus5'],
    preferredCats: ['opus5'],
    labels: ['needs-me'],
    pinned: false,
    favorited: false,
    lastActiveAt: 20,
    createdAt: 10,
    unreadCount: 2,
    hasUserMention: true,
    presence: { status: 'done', cats: ['opus5'] },
  },
];

function ok(): Response {
  const response = new Response(JSON.stringify({ threads: THREADS }), { status: 200, headers: { etag: ETAG } });
  markApiGetGeneration(response, 1);
  return response;
}

describe('Sidebar conditional snapshot side-effect boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSidebarRefreshForTests();
    useSidebarProjectionStore.setState({
      rows: [],
      appliedGeneration: 0,
      hasCanonicalSnapshot: false,
      pendingThreadCommands: {},
      refreshing: false,
    });
    useChatStore.setState({ threads: [], threadStates: {} });
  });

  it('does not apply either store or write either IndexedDB snapshot after a 304', async () => {
    const applySpy = vi.spyOn(useSidebarProjectionStore.getState(), 'applySidebarSnapshot');
    const setThreadsSpy = vi.spyOn(useChatStore.getState(), 'setThreads');
    const unchanged = new Response(null, { status: 304, headers: { etag: ETAG } });
    const parse304 = vi.spyOn(unchanged, 'json');
    mockApiFetch.mockResolvedValueOnce(ok()).mockResolvedValueOnce(unchanged);

    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(true);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(setThreadsSpy).toHaveBeenCalledTimes(1);
    expect(mockSaveSidebarSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSaveThreads).toHaveBeenCalledTimes(1);

    await expect(invalidateSidebarProjection()).resolves.toBe(true);
    expect(parse304).not.toHaveBeenCalled();
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(setThreadsSpy).toHaveBeenCalledTimes(1);
    expect(mockSaveSidebarSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSaveThreads).toHaveBeenCalledTimes(1);
  });
});
