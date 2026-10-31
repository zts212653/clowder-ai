import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type MessageDispositionPreferenceController,
  useMessageDispositionPreference,
} from '@/hooks/useMessageDispositionPreference';

describe('message disposition preference with the real api client', () => {
  const originalFetch = globalThis.fetch;
  let container: HTMLDivElement;
  let root: Root;
  let latest: MessageDispositionPreferenceController | null;

  function Probe() {
    latest = useMessageDispositionPreference('thread-1', false);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    React.act(() => root.render(<Probe />));
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.useRealTimers();
  });

  it('settles a save through apiFetch when the native business fetch never settles', async () => {
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      if (String(url).includes('/api/session')) return Promise.resolve(new Response('{}', { status: 200 }));
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;

    const controller = latest;
    if (!controller) throw new Error('preference probe did not render');
    let savePromise = Promise.resolve(false);
    React.act(() => {
      savePromise = controller.setPreference('global', 'continue_current');
    });
    expect(latest?.loading).toBe(true);

    await React.act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await expect(savePromise).resolves.toBe(false);
    });

    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBe('网络请求超时，请重试。');
  });
});
