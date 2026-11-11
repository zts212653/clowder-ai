import { afterEach, expect, it, vi } from 'vitest';
import { useRoutingPreview } from '@/hooks/useRoutingPreview';
import { apiFetch } from '@/utils/api-client';
import { act, cleanup, renderHook } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});

it('keeps unchanged idle and pending routing data while the draft changes', async () => {
  vi.useFakeTimers();
  let text = '',
    enabled = false;
  vi.mocked(apiFetch).mockClear();
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() =>
    useRoutingPreview({ enabled, content: text, scope: { scope: 'thread', threadId: 'thread' } }),
  );
  const idle = hook.result.current;
  text = 'h';
  await act(hook.rerender);
  expect(hook.result.current).toBe(idle);
  expect(apiFetch).not.toHaveBeenCalled();
  enabled = true;
  await act(hook.rerender);
  const pending = hook.result.current;
  expect(pending.status).toBe('loading');
  text = 'he';
  await act(hook.rerender);
  expect(hook.result.current).toBe(pending);
  await act(async () => vi.advanceTimersByTimeAsync(150));
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('retains an identical routing receipt while still asking the router about the complete draft', async () => {
  vi.useFakeTimers();
  let text = '',
    cats = ['codex'];
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({ targetCats: cats, reason: { kind: 'default_cat' } }),
  );
  const hook = renderHook(() =>
    useRoutingPreview({ enabled: true, content: text, scope: { scope: 'thread', threadId: 'thread' } }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(150));
  const base = hook.result.current;
  expect(base.status).toBe('ready');
  text = 'hello world';
  await act(hook.rerender);
  await act(async () => vi.advanceTimersByTimeAsync(150));
  expect(hook.result.current).toBe(base);
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/routing/preview',
    expect.objectContaining({
      body: JSON.stringify({ scope: 'thread', threadId: 'thread', content: text }),
    }),
  );
  cats = ['other'];
  text += '!';
  await act(hook.rerender);
  await act(async () => vi.advanceTimersByTimeAsync(150));
  expect(hook.result.current).not.toBe(base);
  expect(hook.result.current.targetCats).toEqual(['other']);
});
