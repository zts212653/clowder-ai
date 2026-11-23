import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useSidebarBindings } from '../useSidebarBindings';
import { useTrashBindings } from '../useTrashBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  invalidateSidebarProjection: vi.fn(async () => true),
  refreshSidebarThreadSnapshot: vi.fn(async () => true),
}));
afterEach(cleanup);
it.each([false, true])('re-reads Group preferences after trash restore (uncertain=%s)', async (uncertain) => {
  vi.clearAllMocks();
  let restored = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST') {
      restored = true;
      if (uncertain) throw new Error('lost response');
      return Response.json({ id: 'restored' });
    }
    if (path === '/api/labels') return Response.json([]);
    if (path.includes('deleted=true')) return Response.json({ threads: [] });
    return Response.json({ groups: restored ? [{ id: 'group', threadIds: ['restored'] }] : [] });
  });
  const sidebar = renderHook(() => useSidebarBindings(fixtureData(), true));
  const trash = renderHook(() => useTrashBindings(true));
  await waitFor(() => expect(sidebar.result.current.data.owner).not.toBeNull());
  await act(async () => {
    const action = trash.result.current.action('trashRestore', { id: 'restored' });
    if (uncertain) await expect(action).rejects.toThrow('lost response');
    else await action;
  });
  expect(sidebar.result.current.data.owner?.preferences.groups).toMatchObject([{ threadIds: ['restored'] }]);
});
