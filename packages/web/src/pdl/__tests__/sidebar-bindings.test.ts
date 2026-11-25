import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { useSidebarBindings } from '../useSidebarBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  invalidateSidebarProjection: vi.fn(async () => true),
  refreshSidebarThreadSnapshot: vi.fn(async () => true),
}));
const preferences = {
  groups: [{ id: 'attention_owner', name: 'Owner group', threadIds: ['pdl-test', 'other'] }],
  aliases: {},
  open: {},
};
beforeEach(() => {
  vi.clearAllMocks();
  useSidebarProjectionStore.setState({ rows: [] });
});
afterEach(cleanup);
it('uses the real organize snapshot and keeps the canonical group until the owner acknowledges', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/labels') return Response.json([]);
    if (init?.method === 'POST')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return Response.json(preferences);
  });
  const data = fixtureData();
  useSidebarProjectionStore.setState({
    rows: [
      {
        id: data.threadId,
        title: 'Owner thread',
        participants: ['codex'],
        pinned: false,
        favorited: false,
        labels: [],
        preferredCats: [],
        projectPath: '/project',
        lastActiveAt: 1,
        systemKind: null,
        isHubThread: false,
        unreadCount: 2,
        hasUserMention: true,
        presence: { status: 'working', cats: ['codex'] },
      },
    ],
  });
  const hook = renderHook(() => useSidebarBindings(data, true));
  await waitFor(() => expect(hook.result.current.data.owner?.preferences.groups).toHaveLength(1));
  expect(hook.result.current.data.attention).toEqual([
    {
      id: data.threadId,
      unreadCount: 2,
      hasUserMention: true,
      presence: { status: 'working', cats: ['codex'] },
      lastWho: 'codex',
    },
  ]);
  const command = {
    action: 'organize',
    groupId: 'attention_owner',
    threadIds: ['new'],
    expectedGroups: preferences.groups.map(({ id, threadIds }) => ({ id, threadIds })),
  };
  let pending!: Promise<boolean>;
  await act(() => {
    pending = hook.result.current.action('sidebarGroupWrite', { value: JSON.stringify(command) });
  });
  expect(hook.result.current.data.owner?.preferences.groups[0].threadIds).toEqual(['pdl-test', 'other']);
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls.at(-1)![1]!.body as string)).toEqual(command);
  await act(async () => {
    finish(
      Response.json({
        ...preferences,
        groups: [{ ...preferences.groups[0], threadIds: ['pdl-test', 'other', 'new'] }],
      }),
    );
    await pending;
  });
  expect(hook.result.current.data.owner?.preferences.groups[0].threadIds).toContain('new');
  expect(invalidateSidebarProjection).toHaveBeenCalledOnce();
});
it('assigns existing label IDs and archives only the requested project owner threads', async () => {
  const data = fixtureData();
  data.threads.push(
    { ...data.threads[0], id: 'second' },
    { ...data.threads[0], id: 'system', systemKind: 'cat_bedroom' } as (typeof data.threads)[number],
    { ...data.threads[0], id: 'other', projectPath: '/other' },
  );
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    Response.json(
      init?.method
        ? { ok: true }
        : path === '/api/labels'
          ? [{ id: 'label-owner', name: 'Owner label', color: '#527b99' }]
          : preferences,
    ),
  );
  const hook = renderHook(() => useSidebarBindings(data, true));
  await waitFor(() => expect(hook.result.current.data.owner).not.toBeNull());
  await act(() => hook.result.current.action('sidebarLabels', { id: 'second', value: '["label-owner"]' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/threads/second',
    expect.objectContaining({ method: 'PATCH', body: '{"labels":["label-owner"]}' }),
    undefined,
  );
  await act(() => hook.result.current.action('sidebarArchive', { id: '/project' }));
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([, init]) => init?.method === 'DELETE')
      .map(([path]) => path),
  ).toEqual(['/api/threads/pdl-test', '/api/threads/second']);
  await act(() => hook.result.current.action('sidebarRestore', { value: '["pdl-test","second"]' }));
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([path]) => path.endsWith('/restore'))
      .map(([path]) => path),
  ).toEqual(['/api/threads/pdl-test/restore', '/api/threads/second/restore']);
});

it('reads Group preferences on foreground/reconnect/proposal invalidations and ignores hidden visibility changes', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => Response.json(path === '/api/labels' ? [] : preferences));
  const hook = renderHook(() => useSidebarBindings(fixtureData(), true));
  await waitFor(() => expect(hook.result.current.data.owner).not.toBeNull());
  const reads = () => vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/config/thread-attention').length;
  for (const event of [
    'focus',
    'online',
    'cat-cafe:socket-reconnected',
    'cat-cafe:proposal-updated',
    'cat-cafe:thread-attention-invalidated',
  ]) {
    const before = reads();
    await act(() =>
      window.dispatchEvent(
        event === 'cat-cafe:proposal-updated'
          ? new CustomEvent(event, { detail: { status: 'approved', createdThreadId: 'created' } })
          : new Event(event),
      ),
    );
    expect(reads()).toBe(before + 1);
    expect(invalidateSidebarProjection).toHaveBeenCalled();
  }
  const beforeUnrelated = reads();
  await act(() =>
    window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: { status: 'rejected' } })),
  );
  expect(reads()).toBe(beforeUnrelated);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const before = reads();
  await act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(reads()).toBe(before);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(reads()).toBe(before + 1);
});

it.each([0, 1, 4, 10])('lets invalidation win over an old Group read at microtask delay %i', async (delay) => {
  let finishOld!: (value: Response) => void;
  let finishNew!: (value: Response) => void;
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/labels') return Response.json([]);
    if (++reads === 1) return Response.json(preferences);
    return new Promise((resolve) => {
      if (reads === 2) finishOld = resolve;
      else finishNew = resolve;
    });
  });
  const hook = renderHook(() => useSidebarBindings(fixtureData(), true));
  await waitFor(() => expect(hook.result.current.data.owner).not.toBeNull());
  await act(() => window.dispatchEvent(new Event('focus')));
  await act(() => window.dispatchEvent(new Event('cat-cafe:thread-attention-invalidated')));
  const next = { ...preferences, groups: [{ ...preferences.groups[0], threadIds: ['created-thread'] }] };
  await act(async () => {
    finishOld(Response.json(preferences));
    for (let n = 0; n < delay; n++) await Promise.resolve();
    finishNew(Response.json(next));
  });
  expect(hook.result.current.data.owner?.preferences).toEqual(next);
  expect(apiFetch).toHaveBeenCalledWith('/api/config/thread-attention', undefined, { afterCurrentGet: true });
});

it('does not install a stale response or failure after a newer Group read has already finished', async () => {
  let failOld!: (error: Error) => void;
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/labels') return Response.json([]);
    if (++reads === 2)
      return new Promise((_resolve, reject) => {
        failOld = reject;
      });
    return Response.json({ ...preferences, groups: reads > 2 ? [] : preferences.groups });
  });
  const hook = renderHook(() => useSidebarBindings(fixtureData(), true));
  await waitFor(() => expect(hook.result.current.data.owner).not.toBeNull());
  await act(() => window.dispatchEvent(new Event('focus')));
  await act(() => window.dispatchEvent(new Event('cat-cafe:thread-attention-invalidated')));
  await act(() => failOld(new Error('obsolete failure')));
  expect(hook.result.current.data.owner?.preferences.groups).toEqual([]);
  expect(hook.result.current.error).toBeNull();
});

it.each([
  'sidebarArchive',
  'sidebarRestore',
])('re-reads Group placement even after uncertain %s writes', async (action) => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method) throw new Error('lost lifecycle response');
    return Response.json(path === '/api/labels' ? [] : preferences);
  });
  const hook = renderHook(() => useSidebarBindings(fixtureData(), true));
  await waitFor(() => expect(hook.result.current.data.owner).not.toBeNull());
  const before = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/config/thread-attention').length;
  await act(async () => {
    await expect(hook.result.current.action(action, { id: '/project', value: '["pdl-test"]' })).rejects.toThrow(
      'lost lifecycle response',
    );
  });
  expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/config/thread-attention')).toHaveLength(
    before + 1,
  );
});

it('derives lastWho from presence.cats when a non-current thread has status done', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => Response.json(path === '/api/labels' ? [] : preferences));
  const data = fixtureData();
  useSidebarProjectionStore.setState({
    rows: [
      {
        id: 'other-done',
        title: 'Replied elsewhere',
        participants: ['codex'],
        pinned: false,
        favorited: false,
        labels: [],
        preferredCats: [],
        projectPath: '/project',
        lastActiveAt: 1,
        systemKind: null,
        isHubThread: false,
        unreadCount: 0,
        hasUserMention: false,
        presence: { status: 'done', cats: ['codex'] },
      },
    ],
  });
  const hook = renderHook(() => useSidebarBindings(data, true));
  await waitFor(() => expect(hook.result.current.data.attention).toHaveLength(1));
  expect(hook.result.current.data.attention[0].lastWho).toBe('codex');
});
