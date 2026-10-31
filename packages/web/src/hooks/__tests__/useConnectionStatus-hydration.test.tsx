import { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  API_URL: 'https://preview.example.test',
  apiFetch: vi.fn(),
}));

import { useConnectionStatus } from '../useConnectionStatus';

function ConnectionHost() {
  const status = useConnectionStatus(null);
  return (
    <main>
      {status.isReadonly && <section role="alert">Offline</section>}
      <input aria-label="draft" defaultValue="server draft" readOnly={status.isReadonly} />
      <output>{status.browserOnline ? 'online' : 'offline'}</output>
    </main>
  );
}

describe('connection status hydration', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([true, false])('hydrates Node navigator into browser online=%s without losing the draft', async (online) => {
    const browserWindow = window;
    try {
      vi.stubGlobal('window', undefined);
      // Node 24 has navigator, but no browser onLine signal.
      vi.stubGlobal('navigator', {});
      container.innerHTML = renderToString(<ConnectionHost />);
    } finally {
      vi.stubGlobal('window', browserWindow);
      vi.stubGlobal('navigator', { onLine: online });
    }
    const serverHost = container.firstChild;
    const input = container.querySelector('input');
    if (!input) throw new Error('SSR draft missing');
    input.value = 'typed before hydration';
    const recoverableErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, <ConnectionHost />, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });
    expect(recoverableErrors).toEqual([]);
    expect(container.firstChild).toBe(serverHost);
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('typed before hydration');
    expect(input.readOnly).toBe(!online);
    expect(container.querySelector('output')?.textContent).toBe(online ? 'online' : 'offline');
  });

  it('reads current connectivity on client mount and follows online/offline events', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    root = createRoot(container);
    await act(async () => root?.render(<ConnectionHost />));
    expect(container.querySelector('input')?.readOnly).toBe(true);
    await act(async () => {
      vi.stubGlobal('navigator', { onLine: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(container.querySelector('input')?.readOnly).toBe(false);
    await act(async () => {
      vi.stubGlobal('navigator', { onLine: false });
      window.dispatchEvent(new Event('offline'));
    });
    expect(container.querySelector('input')?.readOnly).toBe(true);
  });

  it('does not label absent server connectivity as offline', () => {
    vi.stubGlobal('navigator', {});
    const html = renderToString(<ConnectionHost />);
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('>online</output>');
  });
});
