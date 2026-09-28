import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { F307WorkbenchSidecar } from '../F307WorkbenchSidecar';
import { createBrowserSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => mocks.desktop }));

const SURFACE = createBrowserSurface({ ownerKey: 'worktree-a', port: 4173, path: '/' });

describe('F307 sidecar physical visibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.desktop = false;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(visible: boolean) {
    await act(async () => {
      root.render(
        <F307WorkbenchSidecar
          surface={SURFACE}
          dispatch={() => undefined}
          visible={visible}
          renderSurface={(_surface, surfaceVisible) => (
            <div data-testid="sidecar-owner" data-surface-visible={String(surfaceVisible)} />
          )}
        />,
      );
    });
  }

  it('keeps a narrow sidecar mounted but marks it visible only while expanded', async () => {
    await render(true);
    const owner = container.querySelector<HTMLElement>('[data-testid="sidecar-owner"]');
    expect(owner?.dataset.surfaceVisible).toBe('false');

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="f307-sidecar-expand"]')?.click());
    expect(owner?.dataset.surfaceVisible).toBe('true');

    await render(false);
    expect(container.querySelector('[data-testid="sidecar-owner"]')).toBe(owner);
    expect(owner?.dataset.surfaceVisible).toBe('false');
  });
});
