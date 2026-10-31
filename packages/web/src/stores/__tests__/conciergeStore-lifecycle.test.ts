import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { useConciergeStore } from '../conciergeStore';

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  useConciergeStore.setState({
    configLoaded: false,
    configLoading: false,
    configFailed: false,
    threadId: null,
    threadIdLoaded: false,
    threadIdLoading: false,
    invocationStatus: 'idle',
    surfaceState: 'collapsed',
    pendingPrompt: null,
    pendingRelayCount: 0,
  });
});
it('loads the saved owner preferences once without changing visibility, selection or old coordinates', async () => {
  const config = {
    ...CONCIERGE_CONFIG_DEFAULTS,
    enabled: false,
    muted: true,
    dutyCatProfileId: 'codex61-sol',
    ballPosition: { x: 83, y: 127 },
  };
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ config })));
  await Promise.all([useConciergeStore.getState().fetchConfig(), useConciergeStore.getState().fetchConfig()]);
  expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
  expect(useConciergeStore.getState()).toMatchObject(config);
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
});
it('exposes configuration failure without starting an automatic retry loop', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
  await useConciergeStore.getState().fetchConfig();
  expect(useConciergeStore.getState()).toMatchObject({ configFailed: true, configLoading: false });
  expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
});
it('discovers an absent carrier without creating a thread or marking a stale carrier loaded', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ threadId: null })));
  await useConciergeStore.getState().readExistingThreadId();
  expect(useConciergeStore.getState()).toMatchObject({ threadId: null, threadIdLoaded: false });
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/concierge/thread');
});
it('a late passive discovery cannot replace an explicitly resolved carrier', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (_url, options) =>
    options?.method === 'POST'
      ? new Response(JSON.stringify({ threadId: 'current' }))
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const passive = useConciergeStore.getState().readExistingThreadId();
  expect(await useConciergeStore.getState().fetchThreadId({ refresh: true })).toBe('current');
  finish(new Response(JSON.stringify({ threadId: 'older' })));
  await passive;
  expect(useConciergeStore.getState().threadId).toBe('current');
});
it('does not accept an invalid carrier body and allows an explicit later retry', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}'));
  expect(await useConciergeStore.getState().fetchThreadId({ refresh: true })).toBeNull();
  expect(useConciergeStore.getState().invocationStatus).toBe('error');
  vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ threadId: 'recovered' })));
  expect(await useConciergeStore.getState().fetchThreadId({ refresh: true })).toBe('recovered');
  expect(useConciergeStore.getState().invocationStatus).toBe('idle');
});
it('preserves explicit empty prompts and clears a cancelled prompt without rendering a shell', () => {
  useConciergeStore.getState().setSurfaceState('bubble', '');
  expect(useConciergeStore.getState().pendingPrompt).toBe('');
  useConciergeStore.getState().setSurfaceState('collapsed');
  expect(useConciergeStore.getState().pendingPrompt).toBeNull();
});
it('retains rich-card relay accounting without inventing a reply from dispatch acknowledgement', () => {
  const store = useConciergeStore.getState();
  store.onRelayDispatching();
  expect(useConciergeStore.getState().pendingRelayCount).toBe(1);
  store.onRelayDispatched();
  store.onRelayFailed();
  expect(useConciergeStore.getState().pendingRelayCount).toBe(0);
});
