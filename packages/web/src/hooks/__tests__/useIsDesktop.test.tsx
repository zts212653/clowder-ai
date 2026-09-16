import { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIsDesktop } from '../useIsDesktop';

function ResponsiveHost() {
  const desktop = useIsDesktop();
  return (
    <main>
      <input aria-label="draft" defaultValue="server draft" />
      {desktop ? <aside>Desktop tools</aside> : <button type="button">Open tools</button>}
    </main>
  );
}

describe('useIsDesktop hydration continuity', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let matches: boolean;
  let listeners: Set<(event: { matches: boolean }) => void>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    matches = true;
    listeners = new Set();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
        removeEventListener: (_event: string, listener: (event: { matches: boolean }) => void) =>
          listeners.delete(listener),
      })),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    root = undefined;
  });

  it.each([true, false])('hydrates viewport desktop=%s without discarding the server DOM or draft', async (desktop) => {
    matches = desktop;
    const browserWindow = window;
    try {
      vi.stubGlobal('window', undefined);
      container.innerHTML = renderToString(<ResponsiveHost />);
    } finally {
      vi.stubGlobal('window', browserWindow);
    }
    const originalHost = container.firstChild;
    const originalInput = container.querySelector('input');
    if (!originalInput) throw new Error('SSR did not render the draft input');
    originalInput.value = 'typed before hydration';
    const recoverableErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, <ResponsiveHost />, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });
    expect(recoverableErrors).toEqual([]);
    expect(container.firstChild).toBe(originalHost);
    expect(container.querySelector('input')).toBe(originalInput);
    expect(originalInput.value).toBe('typed before hydration');
    expect(Boolean(container.querySelector('aside'))).toBe(desktop);
  });

  it('uses the current viewport on a client-only mount and follows changes until unmount', () => {
    root = createRoot(container);
    act(() => root?.render(<ResponsiveHost />));
    expect(container.querySelector('aside')).not.toBeNull();
    act(() => {
      matches = false;
      for (const listener of listeners) listener({ matches });
    });
    expect(container.querySelector('aside')).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('Open tools');
    act(() => root?.unmount());
    root = undefined;
    expect(listeners.size).toBe(0);
  });

  it('keeps the narrow fallback when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    root = createRoot(container);
    act(() => root?.render(<ResponsiveHost />));
    expect(container.querySelector('button')?.textContent).toBe('Open tools');
  });
});
