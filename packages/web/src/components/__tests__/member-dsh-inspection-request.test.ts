import { afterEach, expect, it, vi } from 'vitest';
import { dshSetupRequest } from '../settings/members/dsh-setup-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
afterEach(() => vi.unstubAllGlobals());

it('shares an unfinished metadata read between the panel and save without a busy rejection', async () => {
  const reading = Promise.withResolvers<Response>();
  const fetch = vi
    .fn()
    .mockReturnValueOnce(reading.promise)
    .mockResolvedValue(Response.json({ error: 'dsh_setup_busy' }, { status: 409 }));
  vi.stubGlobal('fetch', fetch);
  const panel = dshSetupRequest('inspect', { runtimeId: 'dsh' });
  const saving = dshSetupRequest('inspect', { runtimeId: 'dsh' });
  reading.resolve(Response.json({ revision: 'read-once', providers: [] }));
  expect(await Promise.allSettled([panel, saving])).toEqual([
    { status: 'fulfilled', value: { revision: 'read-once', providers: [] } },
    { status: 'fulfilled', value: { revision: 'read-once', providers: [] } },
  ]);
  expect(fetch).toHaveBeenCalledOnce();
});

it('rereads after completion and after failure rather than caching either result', async () => {
  const failing = Promise.withResolvers<Response>();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ revision: 'first' }))
    .mockReturnValueOnce(failing.promise)
    .mockResolvedValueOnce(Response.json({ revision: 'latest' }));
  vi.stubGlobal('fetch', fetch);
  expect(await dshSetupRequest('inspect', { runtimeId: 'dsh' })).toEqual({ revision: 'first' });
  const readers = [dshSetupRequest('inspect', { runtimeId: 'dsh' }), dshSetupRequest('inspect', { runtimeId: 'dsh' })];
  failing.resolve(Response.json({ error: 'dsh_setup_changed' }, { status: 409 }));
  await Promise.all(readers.map((request) => expect(request).rejects.toThrow('dsh_setup_changed')));
  expect(await dshSetupRequest('inspect', { runtimeId: 'dsh' })).toEqual({ revision: 'latest' });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('keeps different sources separate and never shares preparation writes', async () => {
  const fetch = vi.fn(async () => Response.json({ revision: 'r' }));
  vi.stubGlobal('fetch', fetch);
  await Promise.all(['first', 'second'].map((runtimeId) => dshSetupRequest('inspect', { runtimeId })));
  await Promise.all([1, 2].map(() => dshSetupRequest('prepare', { runtimeId: 'first', revision: 'r' })));
  expect(fetch).toHaveBeenCalledTimes(4);
});
