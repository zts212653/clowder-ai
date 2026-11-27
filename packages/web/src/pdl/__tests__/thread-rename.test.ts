import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { type SidebarSnapshotRow, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { renameThreadTitleOptimistic } from '../thread-rename';

vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn() }));

function setTitle(threadId: string, title: string) {
  useChatStore.setState({ threads: [{ id: threadId, title } as never] });
}
function title(threadId: string) {
  return useChatStore.getState().threads.find((thread) => thread.id === threadId)?.title;
}

describe('renameThreadTitleOptimistic', () => {
  beforeEach(() => {
    useChatStore.setState({ threads: [] });
    useSidebarProjectionStore.setState({ rows: [], pendingThreadCommands: {}, refreshing: false });
    vi.mocked(invalidateSidebarProjection).mockReset();
  });

  it('shows the new title before the request resolves and applies the server title', async () => {
    setTitle('rename-a', 'old');
    let resolve!: (value: { title: string }) => void;
    const patch = vi.fn(
      () =>
        new Promise<{ title: string }>((done) => {
          resolve = done;
        }),
    );
    const pending = renameThreadTitleOptimistic('rename-a', 'new', patch);
    expect(title('rename-a')).toBe('new');
    await Promise.resolve();
    await Promise.resolve();
    expect(patch).toHaveBeenCalledWith('rename-a', 'new');
    resolve({ title: 'server-new' });
    await pending;
    expect(title('rename-a')).toBe('server-new');
  });

  it('rolls back when the request fails', async () => {
    setTitle('rename-b', 'old');
    const patch = vi.fn(async () => {
      throw new Error('rename rejected');
    });
    await expect(renameThreadTitleOptimistic('rename-b', 'new', patch)).rejects.toThrow('rename rejected');
    expect(title('rename-b')).toBe('old');
  });

  it('lets the later rename win when an earlier response arrives last', async () => {
    setTitle('rename-c', 'old');
    let resolveFirst!: (value: { title: string }) => void;
    const first = vi.fn(
      () =>
        new Promise<{ title: string }>((done) => {
          resolveFirst = done;
        }),
    );
    const second = vi.fn(async () => ({ title: 'second-server' }));
    const firstPending = renameThreadTitleOptimistic('rename-c', 'first', first);
    const secondPending = renameThreadTitleOptimistic('rename-c', 'second', second);
    expect(title('rename-c')).toBe('second');
    await Promise.resolve();
    await Promise.resolve();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    resolveFirst({ title: 'first-server' });
    await firstPending;
    expect(title('rename-c')).toBe('second');
    await secondPending;
    expect(title('rename-c')).toBe('second-server');
  });

  it('restores the last confirmed title when two queued renames are rejected', async () => {
    setTitle('rename-d', 'confirmed');
    const patch = vi.fn(async () => {
      throw new Error('rejected');
    });

    const results = await Promise.allSettled([
      renameThreadTitleOptimistic('rename-d', 'first optimistic', patch),
      renameThreadTitleOptimistic('rename-d', 'second optimistic', patch),
    ]);
    expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    expect(title('rename-d')).toBe('confirmed');
  });

  it('keeps the confirmed title while a sidebar request that began before the write is still outstanding', async () => {
    setTitle('rename-e', 'old');
    const refresh = Promise.withResolvers<boolean>();
    vi.mocked(invalidateSidebarProjection).mockReturnValue(refresh.promise);
    useSidebarProjectionStore.getState().setRefreshing(true);

    await renameThreadTitleOptimistic('rename-e', 'new', async () => ({ title: 'canonical new' }));

    expect(title('rename-e')).toBe('canonical new');
    expect(invalidateSidebarProjection).toHaveBeenCalledOnce();
    expect(Object.values(useSidebarProjectionStore.getState().pendingThreadCommands)).toMatchObject([
      { threadId: 'rename-e', field: 'title', value: 'canonical new' },
    ]);
    refresh.resolve(false);
    await refresh.promise;
    expect(Object.values(useSidebarProjectionStore.getState().pendingThreadCommands)).toMatchObject([
      { threadId: 'rename-e', field: 'title', value: 'canonical new' },
    ]);
  });

  it('keeps the receipt over an old canonical title until the sidebar observes it', async () => {
    const row = {
      id: 'rename-idle',
      title: 'old',
      participants: [],
      pinned: false,
      favorited: false,
      labels: [],
      preferredCats: [],
      projectPath: '',
      lastActiveAt: 0,
      systemKind: null,
      isHubThread: false,
      unreadCount: 0,
      hasUserMention: false,
      presence: { status: 'idle' },
    } satisfies SidebarSnapshotRow;
    setTitle(row.id, row.title);
    useSidebarProjectionStore.setState({ rows: [row], pendingThreadCommands: {}, refreshing: false });
    vi.mocked(invalidateSidebarProjection).mockResolvedValue(false);

    await renameThreadTitleOptimistic(row.id, 'renamed', async () => ({ title: 'confirmed by API' }));
    expect(invalidateSidebarProjection).toHaveBeenCalledOnce();
    expect(Object.values(useSidebarProjectionStore.getState().pendingThreadCommands)).toMatchObject([
      { threadId: row.id, value: 'confirmed by API' },
    ]);

    await expect(
      renameThreadTitleOptimistic(row.id, 'rejected', async () => {
        throw new Error('rejected');
      }),
    ).rejects.toThrow('rejected');
    expect(Object.values(useSidebarProjectionStore.getState().pendingThreadCommands)).toMatchObject([
      { threadId: row.id, value: 'confirmed by API' },
    ]);
    const projection = useSidebarProjectionStore.getState();
    projection.applySidebarSnapshot([{ ...row, title: 'confirmed by API' }], projection.appliedGeneration + 1);
    expect(useSidebarProjectionStore.getState().pendingThreadCommands).toEqual({});
  });
});
