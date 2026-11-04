// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCollectiveParticipation } from '../use-collective-participation';

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: fetcher }));
let root: Root;
let state: ReturnType<typeof useCollectiveParticipation>;
const view = {
  cats: [],
  requests: [],
  tasks: [],
  bindings: {},
  channelRoutes: {},
  standingInterests: {},
  desiredParticipation: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
  attentionRevision: 0,
  revision: 1,
};
function Harness({ connectionId = 'first' }: { connectionId?: string }) {
  state = useCollectiveParticipation(connectionId);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetcher
    .mockReset()
    .mockImplementation(
      (path: string) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ ...view, revision: path.includes('/second/') ? 2 : 1 }), { status: 200 }),
              ),
            6_000,
          ),
        ),
    );
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('loads participation through a response slower than the background interval', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTimeAsync(7_000));
  expect(state.view?.revision).toBe(1);
  expect(state.error).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps the new connection isolated when an older slow read completes', async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  await act(async () => root.render(<Harness connectionId="second" />));
  await act(async () => vi.advanceTimersByTimeAsync(4_100));
  expect(state.view).toBeUndefined();
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(state.view?.revision).toBe(2);
});
