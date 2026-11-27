import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBrakeStore } from '@/stores/brakeStore';
import { apiFetch } from '@/utils/api-client';
import { useBrakeBindings, useOpsBindings } from '../useOpsBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const event = { level: 2 as const, activeMinutes: 155, nightMode: false, mode: 'hardcore' as const, timestamp: 1 };
const emit = vi.fn();
beforeEach(() => {
  vi.mocked(apiFetch)
    .mockReset()
    .mockResolvedValue(response({ enabled: true, thresholdMinutes: 150, mode: 'hardcore' }));
  useBrakeStore.setState({ visible: false, bypassDisabled: false, level: 1, activeMinutes: 0 });
  emit.mockClear();
  Object.defineProperty(window, 'clowderChat', { configurable: true, value: { emit } });
});
afterEach(cleanup);

const ui = () => ({
  opsView: 'brake',
  obsV: 'overview',
  lbRange: 'all',
  toolCat: '',
  toolType: '',
  toolRange: 7,
  rpReview: false,
  rpArch: false,
});

it('projects an actual socket store event once the engine is ready and forwards the owner bypass restriction', async () => {
  let ready = false;
  const { result } = renderHook(() => {
    useBrakeBindings(ready);
    return useOpsBindings(fixtureData(), ui(), true);
  });
  await act(() => useBrakeStore.getState().show(event));
  expect(emit).not.toHaveBeenCalled();
  ready = true;
  await act(() => result.current.action('opsBrowse', {}));
  expect(emit).toHaveBeenLastCalledWith('brake:show', { level: 2, minutes: 155, bypassDisabled: false });
  await act(() => useBrakeStore.setState({ bypassDisabled: true }));
  expect(emit).toHaveBeenLastCalledWith('brake:show', { level: 2, minutes: 155, bypassDisabled: true });
});

it.each([
  'rest',
  'wrap_up',
  'continue',
])('checks in %s through the real owner and closes only after acknowledgement', async (choice) => {
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui(), true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui(), fixtureData(), undefined).opsBrakeSettings?.thresholdMinutes).toBe(
      150,
    ),
  );
  await act(() => useBrakeStore.getState().show(event));
  let acknowledge!: () => void;
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method === 'POST')
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    return response({ ok: true, nextCheckMinutes: 10 });
  });
  let pending!: Promise<boolean>;
  const reason = choice === 'continue' ? 'finish the current owner task' : '';
  await act(() => {
    pending = result.current.action('brakeCheckin', { choice, reason });
  });
  expect(useBrakeStore.getState().visible).toBe(true);
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/brake/checkin',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ choice, reason }) }),
    undefined,
  );
  await act(async () => {
    acknowledge();
    await pending;
  });
  expect(useBrakeStore.getState().visible).toBe(false);
});

it('retains a failed checkin and consumes bypassDisabled from its actual receipt', async () => {
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui(), true));
  await act(() => useBrakeStore.getState().show(event));
  vi.mocked(apiFetch).mockResolvedValueOnce(response({ error: 'owner rejected' }, 403));
  await act(async () => {
    await expect(result.current.action('brakeCheckin', { choice: 'continue', reason: 'owner reason' })).rejects.toThrow(
      'owner rejected',
    );
  });
  expect(useBrakeStore.getState().visible).toBe(true);
  vi.mocked(apiFetch).mockResolvedValueOnce(response({ ok: true, nextCheckMinutes: -1, bypassDisabled: true }));
  await act(async () => {
    await expect(result.current.action('brakeCheckin', { choice: 'continue', reason: 'owner reason' })).rejects.toThrow(
      '继续次数已用完',
    );
  });
  expect(useBrakeStore.getState()).toMatchObject({ visible: true, bypassDisabled: true });
});
