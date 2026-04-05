import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePreviewOnly } from '@/components/workspace/WorkspacePreviewOnly';

vi.mock('@/components/workspace/BrowserPanel', () => ({
  BrowserPanel: ({ previewOnly }: { previewOnly?: boolean }) =>
    React.createElement('div', {
      'data-testid': 'browser-panel',
      'data-preview-only': previewOnly ? '1' : '0',
    }),
}));

describe('WorkspacePreviewOnly', () => {
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
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders browser panel in previewOnly mode and exits on button click', async () => {
    const onExit = vi.fn();
    await act(async () => {
      root.render(React.createElement(WorkspacePreviewOnly, { onExit, initialPort: 5173, initialPath: '/' }));
    });

    const browserPanel = container.querySelector('[data-testid="browser-panel"]');
    expect(browserPanel?.getAttribute('data-preview-only')).toBe('1');

    const exitButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('退出专注'),
    );
    expect(exitButton).toBeTruthy();

    await act(async () => {
      exitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('exits on Escape key', async () => {
    const onExit = vi.fn();
    await act(async () => {
      root.render(React.createElement(WorkspacePreviewOnly, { onExit }));
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
