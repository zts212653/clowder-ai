import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: data.apiFetch }));

import { useEntrustedWorkProjection } from '../useEntrustedWorkProjection';

it.each([
  false,
  true,
])('never confirms a retry of a failed projection (earlier success: %s)', async (earlierSuccess) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  data.apiFetch.mockReset();
  data.apiFetch.mockResolvedValue(
    earlierSuccess ? Response.json({ ownerReads: [] }) : new Response('', { status: 503 }),
  );
  const root = createRoot(document.createElement('div'));
  let latest: ReturnType<typeof useEntrustedWorkProjection>;
  function Reader() {
    latest = useEntrustedWorkProjection('needs-me');
    return null;
  }
  try {
    await act(async () => root.render(<Reader />));
    if (earlierSuccess) {
      expect(latest!.confirmed).toBe(true); // A successful empty read really confirms zero.
      data.apiFetch.mockResolvedValue(new Response('', { status: 503 }));
      await act(async () => {
        void latest!.refetch();
      });
    }
    expect(latest!.error).toBe(true);
    data.apiFetch.mockImplementation(() => new Promise<Response>(() => {}));
    await act(async () => {
      void latest!.refetch();
    });
    expect(latest!.loading).toBe(true);
    expect(latest!.error).toBe(false);
    expect(latest!.confirmed).toBe(false);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
