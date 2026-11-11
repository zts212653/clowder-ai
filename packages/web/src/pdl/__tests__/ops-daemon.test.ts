import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useOpsBindings } from '../useOpsBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
afterEach(cleanup);
const ui = () => ({
  opsView: 'daemon',
  obsV: 'overview',
  lbRange: 'all',
  toolCat: '',
  toolType: '',
  toolRange: 7,
  rpReview: false,
  rpArch: false,
});
it('keeps every registered daemon identity and copies the corresponding attach command without executing it', async () => {
  const sessions = [
    { daemonShortId: 'owner-active', state: 'working', cwd: '/owner-workspace' },
    { daemonShortId: 'owner-failed', state: 'error', detail: 'Owner diagnostic', updatedAt: '2026-11-03T00:00:00Z' },
  ];
  vi.mocked(apiFetch)
    .mockReset()
    .mockResolvedValue(new Response(JSON.stringify(sessions)));
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui(), true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui(), fixtureData(), undefined).cafeWsOps.load).toBe(''),
  );
  const model = projectOwner('ops', result.current, ui(), fixtureData(), undefined).cafeWsOps as {
    daemon: { rows: { id: string; state: string; attachCmd: string }[]; diag: unknown[] };
  };
  expect(model.daemon.rows.map((r) => r.id)).toEqual(['owner-active', 'owner-failed']);
  expect(model.daemon.rows[0].state).toBe('working');
  expect(model.daemon.rows[1].attachCmd).toBe('claude attach owner-failed');
  expect(model.daemon.diag).toContainEqual({ id: 'owner-failed', detail: 'Owner diagnostic', state: 'error' });
  expect(vi.mocked(apiFetch).mock.calls).toEqual([['/api/agent-sessions', undefined, undefined]]);
});
it('shows a failed read as an exception, then re-reads the real empty catalogue on refresh', async () => {
  vi.mocked(apiFetch)
    .mockReset()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'owner_unavailable' }), { status: 503 }))
    .mockResolvedValueOnce(new Response('[]'));
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui(), true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui(), fixtureData(), undefined).cafeWsOps.load).toBe('error'),
  );
  await act(() => result.current.action('refresh', { k: 'daemon' }));
  expect(projectOwner('ops', result.current, ui(), fixtureData(), undefined).cafeWsOps).toMatchObject({
    load: '',
    daemon: { has: false, rows: [] },
  });
});
