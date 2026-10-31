import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLauncherSearch } from '../WorkspaceLauncherSearch';

/** The classic home's search field, pinned: the new shell's home restyles it only through explicit props. */
describe('WorkspaceLauncherSearch defaults', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps the classic words and field when no variant is given', async () => {
    await act(async () => root.render(<WorkspaceLauncherSearch query="" onQueryChange={() => undefined} />));
    const input = container.querySelector('input');
    expect(input?.placeholder).toBe('搜索文件、任务、状态或陪伴…');
    expect(container.querySelector('label')?.className).toBe(
      'mb-5 flex items-center gap-2 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] px-3.5 py-3 focus-within:border-cafe-accent/45',
    );
    expect(input?.getAttribute('data-testid')).toBe('workspace-launcher-search');
  });

  it('takes the new shell’s words and field when it is given them', async () => {
    await act(async () =>
      root.render(
        <WorkspaceLauncherSearch
          query=""
          onQueryChange={() => undefined}
          placeholder="搜索文件和工具…"
          labelClassName="home-search"
        />,
      ),
    );
    expect(container.querySelector('input')?.placeholder).toBe('搜索文件和工具…');
    expect(container.querySelector('label')?.className).toBe('home-search');
  });
});
