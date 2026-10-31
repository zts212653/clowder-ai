import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import {
  dismissConciergeDesktopLossNotice,
  refreshConciergeDesktop,
  reopenConciergeDesktopLossNotice,
  resetConciergeDesktopObservation,
  showConciergeDesktop,
  useConciergeDesktopStore,
  watchConciergeDesktop,
} from '../conciergeDesktopStore';

const fetch = vi.mocked(apiFetch);
const response = (state: 'visible' | 'hidden', maxAgeMs = 3000) =>
  ({ ok: true, json: async () => ({ presence: { state, maxAgeMs } }) }) as Response;
beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  resetConciergeDesktopObservation();
  fetch.mockReset();
});
afterEach(() => {
  resetConciergeDesktopObservation();
  window.sessionStorage.clear();
  vi.useRealTimers();
});
it('dismisses only the observed loss across repeat reads and reload, then shows a new loss', async () => {
  let lossId = 'loss-A';
  let recovered = false;
  fetch.mockImplementation(
    async () =>
      ({
        ok: true,
        json: async () =>
          recovered
            ? { presence: { state: 'visible', maxAgeMs: 3000 } }
            : { presence: null, desktopLost: true, lossId },
      }) as Response,
  );

  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toMatchObject({
    desktopLost: true,
    lossId: 'loss-A',
    noticeVisible: true,
  });
  dismissConciergeDesktopLossNotice();
  expect(useConciergeDesktopStore.getState()).toMatchObject({
    desktopLost: true,
    lossId: 'loss-A',
    noticeVisible: false,
  });
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState().noticeVisible).toBe(false);

  const stopWatching = watchConciergeDesktop();
  await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(useConciergeDesktopStore.getState().noticeVisible).toBe(false);
  stopWatching();

  resetConciergeDesktopObservation(); // A page reload recreates observation, not the session acknowledgement.
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toMatchObject({ desktopLost: true, noticeVisible: false });

  reopenConciergeDesktopLossNotice();
  expect(useConciergeDesktopStore.getState().noticeVisible).toBe(true);
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState().noticeVisible).toBe(true);
  dismissConciergeDesktopLossNotice();

  recovered = true;
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toMatchObject({ visible: true, desktopLost: false });
  recovered = false;
  lossId = 'loss-B';
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toMatchObject({
    desktopLost: true,
    lossId: 'loss-B',
    noticeVisible: true,
  });
});

it('closing the notice does not claim recovery, and failed reads keep the observed loss hidden', async () => {
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ presence: null, desktopLost: true, lossId: 'loss-A' }),
  } as Response);
  await refreshConciergeDesktop();
  dismissConciergeDesktopLossNotice();
  fetch.mockRejectedValueOnce(new Error('owner unavailable'));
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toMatchObject({
    visible: false,
    desktopLost: true,
    lossId: 'loss-A',
    noticeVisible: false,
  });
});
it('fresh visible desktop hides the Hub body, then expires without another response', async () => {
  fetch.mockResolvedValue(response('visible'));
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState().visible).toBe(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(useConciergeDesktopStore.getState()).toMatchObject({ visible: false, desktopLost: false });
});
it('a failed owner read restores the web entry without inventing a desktop crash', async () => {
  fetch.mockResolvedValueOnce(response('visible'));
  await refreshConciergeDesktop();
  fetch.mockRejectedValueOnce(new Error('network unavailable'));
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toEqual({
    visible: false,
    available: false,
    desktopLost: false,
    lossId: null,
    noticeVisible: false,
  });
});
it('hidden or unavailable desktop leaves the Hub entry available', async () => {
  fetch.mockResolvedValue(response('hidden'));
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toEqual({
    visible: false,
    available: true,
    desktopLost: false,
    lossId: null,
    noticeVisible: false,
  });
  fetch.mockRejectedValue(new Error('offline'));
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toEqual({
    visible: false,
    available: false,
    desktopLost: false,
    lossId: null,
    noticeVisible: false,
  });
});

it('desktop loss identifies the web entry as a fallback until a new visible observation', async () => {
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ presence: null, desktopLost: true }) } as Response);
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toMatchObject({ visible: false, desktopLost: true });
  fetch.mockRejectedValueOnce(new Error('owner status unavailable'));
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toMatchObject({ visible: false, desktopLost: true });
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ presence: null, desktopLost: false }) } as Response);
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toMatchObject({ visible: false, desktopLost: false });
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ presence: null, desktopLost: true }) } as Response);
  await refreshConciergeDesktop();
  fetch.mockResolvedValueOnce(response('visible'));
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState()).toMatchObject({ visible: true, desktopLost: false });
});
it('late replies after cleanup cannot re-hide the Hub and parallel refresh shares one request', async () => {
  let deliver!: (r: Response) => void;
  fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  const first = refreshConciergeDesktop();
  const second = refreshConciergeDesktop();
  expect(first).toBe(second);
  expect(fetch).toHaveBeenCalledTimes(1);
  resetConciergeDesktopObservation();
  deliver(response('visible'));
  await first;
  expect(useConciergeDesktopStore.getState().visible).toBe(false);
});
it('showing the current desktop takes no identity selector and rejects stale earlier observations', async () => {
  let earlier!: (r: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        earlier = resolve;
      }),
  );
  const read = refreshConciergeDesktop();
  fetch.mockResolvedValueOnce(response('visible'));
  expect(await showConciergeDesktop()).toBe(true);
  earlier(response('hidden'));
  await read;
  expect(useConciergeDesktopStore.getState().visible).toBe(true);
  expect(fetch).toHaveBeenLastCalledWith('/api/concierge/desktop/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
});

it('does not erase an observed desktop loss or claim recovery when show fails or stays hidden', async () => {
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ presence: null, desktopLost: true }) } as Response);
  await refreshConciergeDesktop();
  expect(useConciergeDesktopStore.getState().desktopLost).toBe(true);

  fetch.mockResolvedValueOnce({ ok: false } as Response);
  expect(await showConciergeDesktop()).toBe(false);
  expect(useConciergeDesktopStore.getState()).toMatchObject({ visible: false, desktopLost: true });

  fetch.mockResolvedValueOnce(response('hidden'));
  expect(await showConciergeDesktop()).toBe(false);
  expect(useConciergeDesktopStore.getState()).toMatchObject({ visible: false, desktopLost: true });

  fetch.mockResolvedValueOnce(response('visible'));
  expect(await showConciergeDesktop()).toBe(true);
  expect(useConciergeDesktopStore.getState()).toMatchObject({ visible: true, desktopLost: false });
});
