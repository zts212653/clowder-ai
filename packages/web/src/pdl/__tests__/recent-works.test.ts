import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useRecentWorks } from '../useRecentWorks';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
it('shares the selected draft project and current conversation project without fetching a global prefix', async () => {
  const data = fixtureData();
  data.threadId = 'default';
  const hook = renderHook(() => useOwnerProjection('recentWorks', useRecentWorks(data, true), { data }));
  expect(hook.result.current.project().recentWorks.rw.load).toBe('empty');
  expect(apiFetch).not.toHaveBeenCalled();
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({
      artifacts: [
        {
          type: 'image',
          name: 'owner.png',
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
    }),
  );
  data.newProjectId = '/target';
  await act(() => hook.result.current.action('cafeRwRetry'));
  await waitFor(() => expect(hook.result.current.project().recentWorks.rw.works.items[0]?.name).toBe('owner.png'));
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/artifacts?view=recent-works&limit=3&projectId=%2Ftarget',
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
