import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  const hook = renderHook(() => useSidebarBindings(fixtureData(), true));
  await waitFor(() => expect(hook.result.current.data.owner?.preferences.groups).toHaveLength(1));
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
