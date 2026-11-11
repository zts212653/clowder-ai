import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useCafeSearchBindings } from '../useCafeSearchBindings';
import { act, cleanup, renderHook, waitFor } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);
it('requests real message/memory search and enables the existing works owner, then publishes data without rereading', async () => {
  const messages = { query: 'needle', results: [] },
    memory = { query: 'needle', groups: [] };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json(String(path).startsWith('/api/evidence/') ? messages : memory),
  );
  const readWorks = vi.fn(async () => true);
  const hook = renderHook(() => useCafeSearchBindings({ artifacts: [], loading: false, error: null }, readWorks, true));
  await act(() => hook.result.current.action('cafeSearchRead', { q: 'needle', sort: 'relevance' }));
  await waitFor(() => expect(hook.result.current.data.messages).toEqual(messages));
  expect(hook.result.current.data.memory).toEqual(memory);
  expect(readWorks).toHaveBeenCalledWith('cafeSearchRead', { q: 'needle', sort: 'relevance' });
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/evidence/search?resultUnit=message&q=needle&mode=hybrid&messageSort=relevance',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    undefined,
  );
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/memory/search?q=needle&type=memory&depth=summary&limit=20',
    expect.anything(),
    undefined,
  );
  vi.mocked(apiFetch).mockClear();
  for (let i = 0; i < 100; i++) expect(hook.result.current.data.messages).toEqual(messages);
  await act(() => hook.result.current.action('cafeSearchRead', { q: 'needle', sort: 'relevance' }));
  expect(apiFetch).not.toHaveBeenCalled();
});
it('keeps successful message data when the independent memory interface fails', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).startsWith('/api/evidence/')
      ? Response.json({ query: 'needle', results: [] })
      : Response.json({ error: 'Memory unavailable' }, { status: 503 }),
  );
  const hook = renderHook(() =>
    useCafeSearchBindings({ artifacts: [], loading: false, error: null }, async () => true, true),
  );
  await act(() => hook.result.current.action('cafeSearchRead', { q: 'needle', sort: 'time' }));
  await waitFor(() => expect(hook.result.current.data.errors.memory).toBeInstanceOf(Error));
  expect(hook.result.current.data.messages?.query).toBe('needle');
  expect(hook.result.current.data.memory).toBeNull();
});
