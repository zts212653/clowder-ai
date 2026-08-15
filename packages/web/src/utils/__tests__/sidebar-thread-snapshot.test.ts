import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const mockSetThreads = vi.fn();
const mockInitThreadUnread = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      setThreads: mockSetThreads,
      initThreadUnread: mockInitThreadUnread,
    }),
  },
}));

import { refreshSidebarThreadSnapshot } from '../sidebar-thread-snapshot';

describe('refreshSidebarThreadSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('coalesces concurrent refreshes and replaces the store with the canonical snapshot', async () => {
    const canonicalThreads = [
      {
        id: 'thread-new',
        title: 'Created while disconnected',
        projectPath: 'default',
        createdBy: 'test-user',
        participants: ['kimi'],
        lastActiveAt: 123,
        createdAt: 100,
        unreadCount: 2,
        hasUserMention: true,
      },
    ];
    let resolveFetch!: (value: { ok: boolean; json: () => Promise<{ threads: typeof canonicalThreads }> }) => void;
    mockApiFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = refreshSidebarThreadSnapshot();
    const second = refreshSidebarThreadSnapshot();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads?view=sidebar');

    resolveFetch({
      ok: true,
      json: () => Promise.resolve({ threads: canonicalThreads }),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(mockSetThreads).toHaveBeenCalledTimes(1);
    expect(mockSetThreads).toHaveBeenCalledWith(canonicalThreads);
    expect(mockInitThreadUnread).toHaveBeenCalledWith('thread-new', 2, true);
  });
});
