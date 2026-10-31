import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSurfaceHeader } from '../WorkspaceSurfaceHeader';

describe('F284 WorkspaceSurfaceHeader', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers a clear return from a destination to the launcher home', async () => {
    const onBack = vi.fn();
    await act(async () => {
      root.render(<WorkspaceSurfaceHeader title="BACKLOG.md" onBack={onBack} />);
    });

    const back = container.querySelector<HTMLButtonElement>('[aria-label="返回 Workspace 首页"]');
    expect(back).not.toBeNull();
    await act(async () => back?.click());
    expect(onBack).toHaveBeenCalledOnce();
  });
});
