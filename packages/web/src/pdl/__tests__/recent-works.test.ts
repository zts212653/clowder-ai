import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useRecentWorks } from '../useRecentWorks';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
it('loads global works in the lobby and keeps explicit project results scoped', async () => {
  const data = fixtureData();
  data.threadId = 'default';
  const projectRead = Promise.withResolvers<void>();
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url.endsWith('projectId=%2Ftarget')) await projectRead.promise;
    return Response.json({
      artifacts: [
        {
          type: 'image',
          name: url.includes('projectId=') ? 'project.png' : 'lobby.png',
          ref: 'content:owner',
          catId: 'codex',
          createdAt: 1,
          threadId: 'source',
          sourceMessageId: 'source-message',
          threadTitle: 'Source',
        },
      ],
      workLineage: 'resolved',
      complete: true,
    });
  });
  const hook = renderHook(() => useOwnerProjection('recentWorks', useRecentWorks(data, true), { data }));
  await waitFor(() => expect(hook.result.current.project().recentWorks.rw.works.items[0]?.name).toBe('lobby.png'));
  expect(apiFetch).toHaveBeenLastCalledWith('/api/artifacts?view=recent-works&limit=3', expect.anything(), undefined);

  data.newProjectId = '/target';
  await act(hook.rerender);
  expect(hook.result.current.project().recentWorks.rw).toEqual({ load: 'loading', works: { items: [] } });
  projectRead.resolve();
  await waitFor(() => expect(hook.result.current.project().recentWorks.rw.works.items[0]?.name).toBe('project.png'));
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/artifacts?view=recent-works&limit=3&projectId=%2Ftarget',
    expect.anything(),
    undefined,
  );
  data.newProjectId = 'default';
  await act(() => hook.result.current.action('cafeRwRetry'));
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/artifacts?view=recent-works&limit=3&projectId=default',
    expect.anything(),
    undefined,
  );

  data.threadId = 'pdl-test';
  await act(() => hook.result.current.action('cafeRwRetry'));
  await waitFor(() =>
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/artifacts?view=recent-works&limit=3&projectId=%2Fproject',
      expect.anything(),
      undefined,
    ),
  );
  await waitFor(() => expect(hook.result.current.project().recentWorkOwners[0]?.threadId).toBe('source'));
});
it('uses the existing list error/retry state for both an error envelope and an incomplete owner read', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: 'owner refused' }));
  const hook = renderHook(() => useOwnerProjection('recentWorks', useRecentWorks(fixtureData(), true)));
  await waitFor(() => expect(hook.result.current.project().recentWorks.rw.load).toBe('error'));
  expect(hook.result.current.project().recentWorks.rw.works.items).toEqual([]);
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ artifacts: [], workLineage: 'unavailable', complete: false }));
  await act(() => hook.result.current.action('cafeRwRetry'));
  await waitFor(() => expect(hook.result.current.project().recentWorks.rw.load).toBe('error'));
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ artifacts: [], workLineage: 'resolved', complete: true }));
  await act(() => hook.result.current.action('cafeRwRetry'));
  await waitFor(() => expect(hook.result.current.project().recentWorks.rw.load).toBe('empty'));
});
it('shows the works a bounded read found even when it could not reach the end of history', async () => {
  const work = {
    type: 'image',
    name: 'found.png',
    ref: 'content:found',
    catId: 'codex',
    createdAt: 1,
    threadId: 'source',
    sourceMessageId: 'source-message',
    threadTitle: 'Source',
  };
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ artifacts: [work], workLineage: 'resolved', complete: false }));
  const hook = renderHook(() => useOwnerProjection('recentWorks', useRecentWorks(fixtureData(), true)));
  await waitFor(() => expect(hook.result.current.project().recentWorks.rw.works.items[0]?.name).toBe('found.png'));
  expect(hook.result.current.project().recentWorks.rw.load).toBe('');
});
