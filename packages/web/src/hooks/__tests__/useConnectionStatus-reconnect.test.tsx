import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useConnectionStatus } from '../useConnectionStatus';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://127.0.0.1:3102', apiFetch: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('socket reconnection immediately probes again without waiting for the poll timer', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }))),
  );
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ cats: [] })));
  function Host({ connected }: { connected: boolean }) {
    const status = useConnectionStatus(connected);
    return <output>{status.socket}</output>;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Host connected={false} />));
    expect(fetch).toHaveBeenCalled();
    vi.mocked(fetch).mockClear();
    await act(async () => root.render(<Host connected />));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/api/health'))).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});
