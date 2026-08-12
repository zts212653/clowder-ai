import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (catId: string) =>
      catId === 'codex-sol' ? { displayName: '砚砚' } : catId === 'kimi' ? { displayName: '墨墨' } : undefined,
  }),
}));

import { WorkspaceNowSurface } from '../WorkspaceNowSurface';

describe('F284 WorkspaceNowSurface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders nothing when there is no active object', async () => {
    await act(async () => {
      root.render(<WorkspaceNowSurface activeInvocations={{}} />);
    });

    expect(container.querySelector('[data-testid="workspace-quiet"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('renders exactly the real running objects instead of a permanent tool inventory', async () => {
    await act(async () => {
      root.render(
        <WorkspaceNowSurface
          activeInvocations={{
            'inv-1': { catId: 'codex-sol', mode: 'interactive-cli', startedAt: 1 },
            'inv-2': { catId: 'kimi', mode: 'headless', startedAt: 2 },
          }}
          repository={{ name: 'cat-cafe', branch: 'feat/f284-ux-implementation' }}
        />,
      );
    });

    expect(container.querySelector('[data-testid="workspace-developing"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="workspace-running-object"]')).toHaveLength(2);
    expect(container.textContent).toContain('cat-cafe');
    expect(container.textContent).toContain('feat/f284-ux-implementation');
  });
});
