import type { ActiveHoldWaitProjection } from '@cat-cafe/shared';
import { beforeEach, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { cancelHoldWait } from '../useActiveExecutionProjection';

const wait = {
  waitId: 'wait-1',
  threadId: 'thread-a',
  catId: 'opus',
  cancelability: { state: 'cancelable', target: { kind: 'hold_ball', taskId: 'hold-1' } },
} as unknown as ActiveHoldWaitProjection;

beforeEach(() => apiFetch.mockReset());

it('cancels a hold and tells the member why when asked', async () => {
  apiFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  expect(await cancelHoldWait(wait, true)).toBe(true);
  expect(apiFetch.mock.calls[0]).toEqual(['/api/callbacks/hold-ball/hold-1?withFeedback=1', { method: 'DELETE' }]);
});

it('posts the feedback on its own when the hold already ended', async () => {
  apiFetch
    .mockResolvedValueOnce(new Response('{}', { status: 404 }))
    .mockResolvedValue(new Response('{}', { status: 200 }));
  expect(await cancelHoldWait(wait, true)).toBe(true);
  expect(apiFetch.mock.calls[1]).toEqual([
    '/api/callbacks/hold-ball/feedback',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-a', taskId: 'hold-1', catId: 'opus' }),
    },
  ]);
});

it('treats an already-ended hold as cancelled without feedback', async () => {
  apiFetch.mockResolvedValue(new Response('{}', { status: 404 }));
  expect(await cancelHoldWait(wait)).toBe(true);
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
