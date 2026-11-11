import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useGeneralBindings } from '../useGeneralBindings';
import { fixtureUi } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);
it('empties a rejected conversation-view read once and does not retry on ordinary commits', async () => {
  let thread = 'known-thread';
  vi.mocked(apiFetch).mockImplementation(async () =>
    thread === 'known-thread'
      ? Response.json({ effective: { mode: 'cat', catId: 'codex' } })
      : Response.json({ error: 'Thread not found' }, { status: 404 }),
  );
  const ui = fixtureUi();
  const hook = renderHook(() => useGeneralBindings(thread, ui, (source) => source === 'view'));
  await waitFor(() => expect(hook.result.current.data.view?.value.effective.mode).toBe('cat'));
  vi.mocked(apiFetch).mockClear();
  thread = 'missing-thread';
  await act(hook.rerender);
  await waitFor(() => expect(hook.result.current.data.viewError).toBeInstanceOf(Error));
  expect(hook.result.current.data.view).toBeNull();
  expect(ui.viewCat).toBeNull();
  for (let i = 0; i < 10; i++) await act(hook.rerender);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(projectOwner('general', hook.result.current, {}, undefined, undefined)).toEqual({});
});
it('reads the global disposition and waits for the behavioral preference writer', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      productDefault: 'next_work',
      global: null,
      thread: null,
      effective: 'next_work',
      source: 'product',
    }),
  );
  const hook = renderHook(() => useGeneralBindings('default', fixtureUi(), () => true));
  await waitFor(() =>
    expect(projectOwner('general', hook.result.current, {}, undefined, undefined).systemGeneral.send).toBe('next'),
  );
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({
      productDefault: 'next_work',
      global: 'continue_current',
      thread: null,
      effective: 'continue_current',
      source: 'global',
    }),
  );
  await act(() => hook.result.current.action('systemSend', { v: 'current' }));
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/config/message-disposition',
    expect.objectContaining({ method: 'PUT', body: '{"scope":"global","disposition":"continue_current"}' }),
    undefined,
  );
  expect(projectOwner('general', hook.result.current, {}, undefined, undefined).systemGeneral.send).toBe('current');
});
it('loads and saves the actual thread reader preference and retains the acknowledged selection after a failed write', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json(
      path.startsWith('/api/config/conversation-view')
        ? { effective: { mode: 'cat', catId: 'codex' } }
        : { effective: 'next_work' },
    ),
  );
  const ui = fixtureUi();
  const hook = renderHook(() => useGeneralBindings('owner-thread', ui, () => true));
  await waitFor(() => expect(hook.result.current.data.view?.value.effective).toEqual({ mode: 'cat', catId: 'codex' }));
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ error: 'owner rejected preference' }, { status: 409 }));
  await expect(hook.result.current.action('conversationView', { v: 'other' })).rejects.toThrow(
    'owner rejected preference',
  );
  expect(hook.result.current.data.view?.value.effective).toEqual({ mode: 'cat', catId: 'codex' });
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ effective: { mode: 'group' } }));
  await act(() => hook.result.current.action('conversationView', { v: '' }));
  expect(ui.viewCat).toBeNull();
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/config/conversation-view',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ threadId: 'owner-thread', view: { mode: 'group' } }),
    }),
    undefined,
  );
});
