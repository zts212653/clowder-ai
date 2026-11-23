import { afterEach, expect, it, vi } from 'vitest';
import { useVisibleCafePresence } from '../../starry/frame-presence';
import { act, cleanup, renderHook } from './hook-host';

vi.mock('@/utils/api-client', () => import('../../starry/frame-api'));

function lifecycle(visible: boolean, origin = window.location.origin, source: Window = window.parent) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      source,
      data: { type: 'clowder-frame-lifecycle', visible },
    }),
  );
}

afterEach(async () => {
  await cleanup();
  lifecycle(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('runs the existing ten-second presence poll only while the host says the frame is visible', async () => {
  vi.useFakeTimers();
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation((message) => {
    if (message.type !== 'clowder-frame-request') return;
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: window.location.origin,
        data: {
          type: 'clowder-frame-response',
          id: message.id,
          status: 200,
          body: { threads: [] },
        },
      }),
    );
  });
  const polls = () => post.mock.calls.filter(([message]) => message.type === 'clowder-frame-request');
  renderHook(() => useVisibleCafePresence({ userId: 'host-session', enabled: true }));
  expect(post).toHaveBeenCalledWith({ type: 'clowder-frame-ready' }, window.location.origin);
  expect(polls()).toHaveLength(0);
  await act(() => lifecycle(true, 'https://other.test'));
  await act(() => lifecycle(true, window.location.origin, document.createElement('iframe').contentWindow!));
  expect(polls()).toHaveLength(0);
  await act(() => lifecycle(true));
  expect(polls()).toHaveLength(1);
  expect(polls()[0][0]).toMatchObject({ method: 'GET', path: '/api/threads?limit=30' });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(polls()).toHaveLength(2);
  await act(() => lifecycle(true));
  expect(polls()).toHaveLength(2);
  await act(() => lifecycle(false));
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(polls()).toHaveLength(2);
  await act(() => lifecycle(true));
  expect(polls()).toHaveLength(3);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(polls()).toHaveLength(4);
  await cleanup();
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(polls()).toHaveLength(4);
});
