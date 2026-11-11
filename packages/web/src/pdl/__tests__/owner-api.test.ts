import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { request } from '../owner-api';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('preserves the raw status and error code through the read boundary and mutation result', async () => {
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({ error: { code: 'stale_revision' } }, { status: 409 }),
  );
  await expect(request('/api/owner')).rejects.toMatchObject({
    name: 'PdlReadError',
    status: 409,
    code: 'stale_revision',
  });
  await expect(request('/api/owner', { method: 'POST' })).rejects.toMatchObject({
    status: 409,
    code: 'stale_revision',
  });
});

it.each([
  [{ error: 'owner unavailable' }, 503, 'owner unavailable'],
  [{ error: { code: 'access_denied' } }, 403, 'access_denied'],
  [{ error: 'owner unavailable' }, 200, 'owner unavailable'],
  [{ error: { code: 'source_changed' }, details: { revision: 2 } }, 200, 'source_changed'],
  [null, 500, '请求失败 (500)'],
])('rejects the owner HTTP error before projecting data: %j', async (body, status, message) => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(body), { status: Number(status) }));
  await expect(request('/api/owner')).rejects.toThrow(String(message));
});

it('keeps legitimate successful records with optional error facts and accepts an empty mutation receipt', async () => {
  const fact = { usageItems: [], error: 'quota unavailable', lastChecked: null };
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify(fact)));
  expect(await request('/api/quota')).toEqual(fact);
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(await request('/api/owner', { method: 'DELETE' })).toBeUndefined();
});

it('marks network read errors for the data boundary and keeps write errors and cancellation unchanged', async () => {
  const error = new TypeError('Network unavailable');
  vi.mocked(apiFetch).mockRejectedValue(error);
  await expect(request('/api/owner')).rejects.toMatchObject({
    name: 'PdlReadError',
    message: error.message,
    cause: error,
  });
  await expect(request('/api/owner', { method: 'POST' })).rejects.toBe(error);
  const abort = new AbortController();
  abort.abort();
  await expect(request('/api/owner', { signal: abort.signal })).rejects.toBe(error);
});
