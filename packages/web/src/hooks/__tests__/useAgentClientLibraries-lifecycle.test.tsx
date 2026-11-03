import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let root: Root;
let container: HTMLDivElement;
let render: (revision?: string, enabled?: boolean) => Promise<void>;
let latest: ReturnType<typeof import('../useAgentClientLibraries').useAgentClientLibraries>;
let signals: AbortSignal[];
let replies: ((response: Response) => void)[];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  signals = [];
  replies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (!url.endsWith('/api/agent-providers')) return Promise.resolve(Response.json({}));
      signals.push(init!.signal!);
      return new Promise<Response>((resolve) => replies.push(resolve));
    }),
  );
  const { useAgentClientLibraries } = await import('../useAgentClientLibraries');
  function Probe({ revision, enabled }: { revision?: string; enabled: boolean }) {
    latest = useAgentClientLibraries(revision, enabled);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render = async (revision, enabled = true) => {
    await React.act(async () => root.render(<Probe revision={revision} enabled={enabled} />));
  };
});

afterEach(async () => {
  await React.act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('leaving the editor cancels the real transport and prevents its 30-second notice during member creation', async () => {
  await render();
  expect(signals).toHaveLength(1);
  await React.act(async () => root.render(<div>Creating members</div>));
  const { apiFetch } = await import('@/utils/api-client');
  await expect(apiFetch('/api/cats', { method: 'POST' })).resolves.toMatchObject({ status: 200 });
  await React.act(async () => vi.advanceTimersByTimeAsync(30_001));
  const { useToastStore } = await import('@/stores/toastStore');
  expect(useToastStore.getState().toasts).toEqual([]);
  expect(signals[0]?.aborted).toBe(true);
  expect(container.textContent).toBe('Creating members');
});

it('revision changes abort stale reads and only publish the latest catalog', async () => {
  await render('old');
  await render('new');
  expect(signals[0]?.aborted).toBe(true);
  expect(signals).toHaveLength(2);
  await React.act(async () => {
    replies[1]!(Response.json({ libraries: [{ pluginId: 'new', configurationKey: null, clients: [] }] }));
  });
  await React.act(async () => {
    replies[0]!(Response.json({ libraries: [{ pluginId: 'old', configurationKey: null, clients: [] }] }));
  });
  expect(latest.libraries.map((item) => item.pluginId)).toEqual(['new']);
  expect(latest.loading).toBe(false);
  expect(latest.error).toBe('');
});

it('disabling the editor cancels its read and re-enabling starts a fresh generation', async () => {
  await render();
  await render(undefined, false);
  expect(signals[0]?.aborted).toBe(true);
  expect(latest).toEqual({ libraries: [], loading: false, error: '' });
  await render();
  expect(signals).toHaveLength(2);
});
