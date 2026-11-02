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
    earlierSuccess
      ? Response.json({ ownerReads: [], coverage: { state: 'complete' } })
      : new Response('', { status: 503 }),
  );
  const root = createRoot(document.createElement('div'));
  let latest: ReturnType<typeof useEntrustedWorkProjection> | undefined;
  function Reader() {
    latest = useEntrustedWorkProjection('needs-me');
    return null;
  }
  try {
    await act(async () => root.render(<Reader />));
    if (earlierSuccess) {
      expect(latest?.confirmed).toBe(true); // A successful empty read really confirms zero.
      data.apiFetch.mockResolvedValue(new Response('', { status: 503 }));
      await act(async () => {
        void latest?.refetch();
      });
    }
    expect(latest?.error).toBe(true);
    data.apiFetch.mockImplementation(() => new Promise<Response>(() => {}));
    await act(async () => {
      void latest?.refetch();
    });
    expect(latest?.loading).toBe(true);
    expect(latest?.error).toBe(false);
    expect(latest?.confirmed).toBe(false);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('preserves successful owner facts but never confirms a partial producer snapshot as complete', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  data.apiFetch.mockReset();
  data.apiFetch.mockResolvedValue(
    Response.json({
      ownerReads: [],
      coverage: {
        state: 'partial',
        unavailableSources: [
          {
            producerId: 'f290.collective_work_result',
            status: 'unavailable',
            reason: 'source_unavailable',
          },
        ],
      },
    }),
  );
  const root = createRoot(document.createElement('div'));
  let latest: ReturnType<typeof useEntrustedWorkProjection> | undefined;
  function Reader() {
    latest = useEntrustedWorkProjection('needs-me');
    return null;
  }
  try {
    await act(async () => root.render(<Reader />));
    expect(latest?.ownerReads).toEqual([]);
    expect(latest?.partial).toBe(true);
    expect(latest?.confirmed).toBe(false);
    expect(latest?.error).toBe(false);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('centralizes stale-row and source coverage into one partial projection state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  data.apiFetch.mockReset();
  data.apiFetch.mockResolvedValue(
    Response.json({
      ownerReads: [
        {
          envelope: {
            subjectRef: 'task:work:stale',
            ownerRef: 'task:item:stale',
            admissionReceiptRef: 'task:receipt:stale',
            sourceRefs: ['message:stale'],
            revision: 2,
            freshness: { state: 'stale', observedRevision: 1 },
            visibility: { ownerUserId: 'owner', human: true, cat: true },
          },
          brief: {
            outcome: { state: 'unknown' },
            current: { state: 'doing', ownerRef: 'task:item:stale', revision: 2 },
            verifiedMilestone: { kind: 'unknown', reason: 'stale_owner_read' },
            nextOwner: { kind: 'unknown' },
            needsMe: { state: 'unknown', reason: 'stale_owner_read' },
          },
          timeRefs: [],
          attentionReceipts: [],
        },
      ],
      coverage: { state: 'complete' },
    }),
  );
  const root = createRoot(document.createElement('div'));
  let latest: ReturnType<typeof useEntrustedWorkProjection> | undefined;
  function Reader() {
    latest = useEntrustedWorkProjection('schedule');
    return null;
  }
  try {
    await act(async () => root.render(<Reader />));
    expect(latest?.ownerReads).toHaveLength(1);
    expect(latest?.partial).toBe(true);
    expect(latest?.confirmed).toBe(false);
    expect(latest?.error).toBe(false);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
